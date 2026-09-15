"""Monitoring worker.

A separate process from the API. It repeatedly:

1. claims a batch of endpoints whose next check is due,
2. probes them concurrently under a bounded semaphore,
3. records each result, applies status transitions, manages incidents and
   raises alerts,
4. schedules the next check with jitter, at the cadence resolved for that
   endpoint - its own interval while healthy, one minute while failing, and
   one minute always in a fast-check environment (see
   ``monitoring_service.resolve_check_interval``).

Claiming uses ``SELECT ... FOR UPDATE SKIP LOCKED`` plus a short lease, so any
number of worker replicas can run against the same database without ever
checking the same endpoint twice, and a worker that dies mid-batch releases its
endpoints when the lease expires rather than stranding them.

Two periodic tasks run alongside the check loop: a retention sweep and an SSL
re-grade that keeps ``days_remaining`` accurate (and fires expiry alerts) even
for endpoints on long intervals.
"""

from __future__ import annotations

import asyncio
import os
import platform
import signal
import socket
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.database import SessionFactory, dispose_engine
from app.core.enums import CheckType
from app.core.logging import configure_logging, get_logger
from app.models.endpoint import Endpoint
from app.models.monitoring import WorkerHeartbeat
from app.monitoring import screenshot
from app.services import (
    alert_service,
    capture_service,
    monitoring_service,
    resource_service,
    retention_service,
    settings_service,
    vantage_service,
)

configure_logging()
logger = get_logger(__name__)

SSL_SWEEP_INTERVAL_SECONDS = 3600


def _now() -> datetime:
    return datetime.now(timezone.utc)


class MonitorWorker:
    def __init__(self) -> None:
        # Identity must be UNIQUE per running process - two workers sharing an
        # id overwrite each other's heartbeat, so a scaled fleet reports as one
        # worker and /health undercounts it. The hostname gives that for free:
        # each Compose replica and each Kubernetes pod has its own.
        #
        # It is not stable across restarts, and does not need to be. A clean
        # shutdown deletes this worker's own heartbeat row (see run()), and a
        # row left behind by a hard kill is removed by the next worker's
        # startup sweep in _heartbeat_loop. Set WORKER_ID explicitly only when
        # you want a fixed name in the fleet view - it must then differ per
        # replica (in Kubernetes: metadata.name via fieldRef).
        self.worker_id = (settings.WORKER_ID or socket.gethostname() or "worker")[:64]
        self.concurrency = max(1, settings.WORKER_CONCURRENCY)
        self._semaphore = asyncio.Semaphore(self.concurrency)
        self._shutdown = asyncio.Event()
        self._started_at = _now()
        self._checks_completed = 0
        self._checks_failed = 0
        self._in_flight = 0
        # Renders in flight. Held so shutdown can wait for them rather than
        # leaving a Chromium page open and a capture row half written.
        self._screenshots: set[asyncio.Task] = set()

    # ------------------------------------------------------------ signals
    def install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self.request_shutdown, sig.name)
            except NotImplementedError:
                # Windows/ProactorEventLoop: fall back to the default handler.
                signal.signal(sig, lambda *_: self.request_shutdown(sig.name))

    def request_shutdown(self, reason: str = "signal") -> None:
        if not self._shutdown.is_set():
            logger.info("worker_shutdown_requested", reason=reason)
            self._shutdown.set()

    # -------------------------------------------------------- heartbeats
    async def _write_heartbeat(self) -> None:
        async with SessionFactory() as session:
            try:
                row = (
                    await session.execute(
                        select(WorkerHeartbeat).where(
                            WorkerHeartbeat.worker_id == self.worker_id
                        )
                    )
                ).scalar_one_or_none()
                # Measured here rather than by the API: only this process can
                # read its own cgroup, and the heartbeat is already a row the
                # API reads - so no extra channel is needed to report it.
                resources = resource_service.process_stats("worker")

                if row is None:
                    session.add(
                        WorkerHeartbeat(
                            worker_id=self.worker_id,
                            started_at=self._started_at,
                            last_seen_at=_now(),
                            checks_completed=self._checks_completed,
                            checks_failed=self._checks_failed,
                            in_flight=self._in_flight,
                            version=settings.APP_VERSION,
                            hostname=platform.node()[:128],
                            region=(settings.WORKER_REGION or None),
                            cpu_percent=resources["cpu_percent"],
                            memory_mb=resources["memory_mb"],
                            memory_limit_mb=resources["memory_limit_mb"],
                        )
                    )
                else:
                    row.last_seen_at = _now()
                    row.checks_completed = self._checks_completed
                    row.checks_failed = self._checks_failed
                    row.in_flight = self._in_flight
                    row.version = settings.APP_VERSION
                    row.region = settings.WORKER_REGION or None
                    # cpu_percent is None on the first heartbeat - a rate needs
                    # two samples - so keep the previous value rather than
                    # blanking a good reading.
                    if resources["cpu_percent"] is not None:
                        row.cpu_percent = resources["cpu_percent"]
                    row.memory_mb = resources["memory_mb"]
                    row.memory_limit_mb = resources["memory_limit_mb"]
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                logger.warning("heartbeat_write_failed", error=str(exc))

    async def _retire_dead_workers(self, *, older_than_seconds: int) -> None:
        """Delete heartbeats belonging to workers that are gone.

        A live worker rewrites its row every WORKER_HEARTBEAT_SECONDS, so a
        heartbeat older than the stale window cannot belong to a running
        process - it is a container that was replaced. Deleting it is safe
        even if we are wrong: the owner simply recreates the row on its next
        beat, because _write_heartbeat inserts when the row is missing.

        This is what stops a rebuild from parking /health at "degraded" while
        an orphan row ages out.
        """
        cutoff = _now() - timedelta(seconds=older_than_seconds)
        try:
            async with SessionFactory() as session:
                result = await session.execute(
                    delete(WorkerHeartbeat).where(
                        WorkerHeartbeat.last_seen_at < cutoff,
                        WorkerHeartbeat.worker_id != self.worker_id,
                    )
                )
                await session.commit()
                if result.rowcount:
                    logger.info(
                        "retired_dead_workers", removed=int(result.rowcount)
                    )
        except SQLAlchemyError as exc:
            logger.warning("worker_retire_failed", error=str(exc))

    async def _heartbeat_loop(self) -> None:
        # Claim our own row first, then clear anything already stale. At this
        # instant a stale row cannot be a running worker, so this immediately
        # removes rows left by containers we replaced instead of leaving
        # /health degraded while they age out.
        await self._write_heartbeat()
        await self._retire_dead_workers(
            older_than_seconds=settings.WORKER_STALE_AFTER_SECONDS
        )
        cycles = 0
        while not self._shutdown.is_set():
            await self._write_heartbeat()
            cycles += 1
            # Roughly every 5 minutes at the default 15s heartbeat. Uses a
            # wider window than the startup sweep so a briefly wedged peer is
            # given room to recover before its row is removed.
            if cycles % 20 == 0:
                await self._retire_dead_workers(
                    older_than_seconds=max(
                        settings.WORKER_STALE_AFTER_SECONDS * 2,
                        settings.WORKER_RETIRE_AFTER_SECONDS,
                    )
                )
            try:
                await asyncio.wait_for(
                    self._shutdown.wait(), timeout=settings.WORKER_HEARTBEAT_SECONDS
                )
            except asyncio.TimeoutError:
                continue

    # ------------------------------------------------------------ claiming
    async def _claim_due_endpoints(self, limit: int) -> list[uuid.UUID]:
        """Reserve up to ``limit`` due endpoints for this worker.

        Row locks are taken with SKIP LOCKED so concurrent workers claim
        disjoint sets without blocking each other, and a lease is stamped so a
        crashed worker's endpoints become claimable again.
        """
        now = _now()
        async with SessionFactory() as session:
            try:
                candidate_stmt = (
                    select(Endpoint.id)
                    .where(
                        Endpoint.monitoring_enabled.is_(True),
                        Endpoint.is_paused.is_(False),
                        (Endpoint.next_check_at.is_(None))
                        | (Endpoint.next_check_at <= now),
                        (Endpoint.lease_expires_at.is_(None))
                        | (Endpoint.lease_expires_at < now),
                    )
                    .order_by(Endpoint.next_check_at.asc().nulls_first())
                    .limit(limit)
                )
                dialect = session.bind.dialect.name if session.bind else ""
                if dialect == "postgresql":
                    candidate_stmt = candidate_stmt.with_for_update(
                        skip_locked=True, of=Endpoint
                    )

                ids = list((await session.execute(candidate_stmt)).scalars().all())
                if not ids:
                    await session.commit()
                    return []

                # Lease long enough to cover the slowest possible check plus
                # the time spent writing its result.
                lease_until = now + timedelta(
                    seconds=max(60, settings.DEFAULT_TIMEOUT * 3 + 60)
                )
                await session.execute(
                    update(Endpoint)
                    .where(Endpoint.id.in_(ids))
                    .values(lease_expires_at=lease_until, leased_by=self.worker_id)
                )
                await session.commit()
                return ids
            except SQLAlchemyError as exc:
                await session.rollback()
                logger.error("claim_failed", error=str(exc))
                return []

    # -------------------------------------------------------------- checks
    async def _check_and_record(self, endpoint_id: uuid.UUID, config: dict) -> None:
        """Run one endpoint's check in its own session and transaction."""
        async with self._semaphore:
            self._in_flight += 1
            try:
                async with SessionFactory() as session:
                    endpoint = (
                        await session.execute(
                            select(Endpoint)
                            .options(
                                selectinload(Endpoint.tags),
                                selectinload(Endpoint.environment),
                            )
                            .where(Endpoint.id == endpoint_id)
                        )
                    ).scalars().unique().one_or_none()

                    if endpoint is None:
                        # Deleted between claim and execution.
                        return
                    if not endpoint.monitoring_enabled or endpoint.is_paused:
                        endpoint.lease_expires_at = None
                        endpoint.leased_by = None
                        endpoint.next_check_at = None
                        await session.commit()
                        return

                    outcome = None
                    try:
                        outcome = await monitoring_service.execute_check(
                            endpoint, config
                        )
                        withhold = await self._vantage_gate(
                            endpoint, outcome, config
                        )
                        await monitoring_service.record_check_result(
                            session,
                            endpoint,
                            outcome,
                            config=config,
                            checked_by=self.worker_id,
                            is_manual=False,
                            withhold_incident_reason=withhold,
                        )
                        # Replaces this endpoint's previous capture for
                        # whichever outcome the check had. Two rows per
                        # endpoint, ever - see capture_service.
                        #
                        # Deliberately in the SAME transaction as the result it
                        # describes: the two commit together or not at all, so
                        # a capture can never claim to be the body of a check
                        # that was never recorded. That makes it capable of
                        # rolling back a good check, which is why
                        # capture_service sanitises everything it writes rather
                        # than trusting a guard here - a caught flush error
                        # would leave the session unusable anyway.
                        await capture_service.record_check(
                            session,
                            endpoint.id,
                            outcome,
                            captured_by=self.worker_id,
                        )
                        self._checks_completed += 1
                        if not outcome.is_up:
                            self._checks_failed += 1
                    finally:
                        # Always re-arm the schedule and drop the lease, even
                        # if recording raised - otherwise a persistently
                        # failing endpoint would be retried in a tight loop.
                        # Resolved from the environment and the outcome just
                        # recorded, not from the stored interval alone: a
                        # production endpoint stays on the fast cadence, and
                        # anything that just failed is retried quickly until
                        # it passes.
                        endpoint.next_check_at = monitoring_service.next_check_for(
                            endpoint, config
                        )
                        endpoint.lease_expires_at = None
                        endpoint.leased_by = None

                    await session.commit()

                    # Only now, with the check committed and the lease
                    # released. Rendering a page takes seconds; doing it
                    # inside the transaction above would hold a row lock and a
                    # connection open for the duration, and a slow page would
                    # delay the thing the worker actually exists to do.
                    if outcome is not None and self._wants_screenshot(endpoint):
                        self._spawn_screenshot(endpoint, outcome)
            except Exception as exc:
                logger.error(
                    "check_cycle_error",
                    endpoint_id=str(endpoint_id),
                    error=str(exc),
                    exc_info=True,
                )
                await self._release_lease(endpoint_id)
            finally:
                self._in_flight -= 1

    # ------------------------------------------------------ vantage points
    async def _vantage_gate(
        self, endpoint: Endpoint, outcome, config: dict
    ) -> str | None:
        """Ask elsewhere before declaring this endpoint down.

        Runs on ONE check per outage: the failing one that would take the
        endpoint over its threshold. Not on every failure - once an incident is
        open the question has been answered - and never on a success.

        Returns the reason to withhold the incident, or None to let the check
        record normally. Every path that is not a confident "reachable from
        elsewhere" returns None, so a missing, busy or confused set of vantage
        points can only ever leave today's behaviour intact. A monitor that
        withholds an alert because a proxy was slow would be worse than one
        with no vantage points at all.
        """
        if outcome.is_up:
            return None
        if not vantage_service.configured():
            return None

        thresholds = monitoring_service.resolve_thresholds(endpoint, config)
        # +1 because this failure has not been counted yet.
        failures = (endpoint.consecutive_failures or 0) + 1
        # Exactly the check that first reaches the threshold, not every failure
        # at or beyond it. Below it nobody is about to be paged; above it the
        # incident is either already open or was withheld once already, and one
        # grace check is the whole of the offer. That also bounds proxy use to
        # one round per outage rather than one per failing check.
        if failures != thresholds["failure_threshold"]:
            return None

        try:
            verdict = await vantage_service.confirm(endpoint, config)
        except Exception as exc:
            logger.warning(
                "vantage_confirmation_error", endpoint=endpoint.name, error=str(exc)[:200]
            )
            return None

        endpoint.last_vantage_check = verdict.as_dict()
        endpoint.last_vantage_check_at = _now()

        if not verdict.reachable_elsewhere:
            return None

        reachable = [r.name for r in verdict.results if r.reachable is True]
        return (
            "Reachable from "
            + ", ".join(reachable[:3])
            + " while failing from this host, so the fault is more likely to be "
            "on the path from here than at the endpoint."
        )[:500]

    # --------------------------------------------------------- screenshots
    def _wants_screenshot(self, endpoint: Endpoint) -> bool:
        """Is a rendered screenshot both wanted and possible for this endpoint?

        Three gates, cheapest first. The check type matters: there is nothing
        to photograph about a TCP handshake, and asking Chromium to open a
        `tcp://` URL would only produce an error to store.
        """
        return (
            settings.SCREENSHOT_ENABLED
            and endpoint.screenshot_enabled
            and endpoint.check_type == CheckType.HTTP.value
        )

    def _spawn_screenshot(self, endpoint: Endpoint, outcome) -> None:
        """Start a render in the background and keep a handle on it.

        Tracked in a set rather than fired and forgotten, so shutdown can wait
        for the ones in flight instead of leaving a Chromium page mid-render
        and a half-written row.
        """
        task = asyncio.create_task(
            self._capture_screenshot(
                endpoint_id=endpoint.id,
                name=endpoint.name,
                # The URL the check actually landed on, which after a redirect
                # or a discovered health path is not the configured one - and
                # the capture should show the page that was judged.
                url=outcome.final_url or endpoint.url,
                verify_ssl=endpoint.verify_ssl,
                outcome=capture_service.outcome_for(outcome),
                checked_at=outcome.checked_at,
            ),
            name=f"screenshot:{endpoint.id}",
        )
        self._screenshots.add(task)
        task.add_done_callback(self._screenshots.discard)

    async def _capture_screenshot(
        self,
        *,
        endpoint_id: uuid.UUID,
        name: str,
        url: str,
        verify_ssl: bool,
        outcome: str,
        checked_at: datetime,
    ) -> None:
        """Render one page and merge it into the capture row it belongs to.

        Swallows everything. A screenshot is an enrichment: nothing about the
        endpoint's status, its incidents or its alerts depends on one, so no
        failure here is allowed to surface as a worker error.
        """
        try:
            shot = await screenshot.capture(url, verify_ssl=verify_ssl)
            async with SessionFactory() as session:
                attached = await capture_service.attach_screenshot(
                    session,
                    endpoint_id,
                    outcome,
                    image=shot.image,
                    width=shot.width,
                    height=shot.height,
                    error=shot.error,
                    captured_at=checked_at,
                )
                await session.commit()
            if attached and shot.ok:
                logger.debug(
                    "screenshot_captured",
                    endpoint=name,
                    outcome=outcome,
                    bytes=len(shot.image or b""),
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "screenshot_capture_error", endpoint=name, error=str(exc)[:200]
            )

    async def _release_lease(self, endpoint_id: uuid.UUID) -> None:
        """Best-effort lease release after a failed check cycle."""
        try:
            async with SessionFactory() as session:
                await session.execute(
                    update(Endpoint)
                    .where(Endpoint.id == endpoint_id)
                    .values(
                        lease_expires_at=None,
                        leased_by=None,
                        next_check_at=_now() + timedelta(seconds=60),
                    )
                )
                await session.commit()
        except SQLAlchemyError as exc:  # pragma: no cover
            logger.warning(
                "lease_release_failed", endpoint_id=str(endpoint_id), error=str(exc)
            )

    async def _run_cycle(self) -> int:
        async with SessionFactory() as session:
            config = await settings_service.load_settings(session)

        # Never claim more than the concurrency budget can absorb at once;
        # otherwise leases start expiring while work is still queued.
        limit = min(settings.WORKER_BATCH_SIZE, self.concurrency * 4)
        ids = await self._claim_due_endpoints(limit)
        if not ids:
            return 0

        logger.debug("cycle_claimed", count=len(ids))
        await asyncio.gather(
            *(self._check_and_record(endpoint_id, config) for endpoint_id in ids),
            return_exceptions=True,
        )
        return len(ids)

    async def _check_loop(self) -> None:
        while not self._shutdown.is_set():
            try:
                processed = await self._run_cycle()
            except Exception as exc:
                logger.error("cycle_failed", error=str(exc), exc_info=True)
                processed = 0

            # A full batch means there is probably more work waiting, so poll
            # again immediately rather than idling.
            if processed >= min(settings.WORKER_BATCH_SIZE, self.concurrency * 4):
                continue
            try:
                await asyncio.wait_for(
                    self._shutdown.wait(),
                    timeout=settings.WORKER_POLL_INTERVAL_SECONDS,
                )
            except asyncio.TimeoutError:
                continue

    # ---------------------------------------------------- periodic tasks
    async def _retention_loop(self) -> None:
        # Stagger the first sweep so several replicas starting together do not
        # all begin deleting at the same moment.
        await self._sleep_or_stop(30 + (os.getpid() % 60))
        while not self._shutdown.is_set():
            try:
                async with SessionFactory() as session:
                    config = await settings_service.load_settings(
                        session, use_cache=False
                    )
                    await retention_service.run_retention_sweep(session, config)
            except Exception as exc:
                logger.error("retention_sweep_error", error=str(exc))
            await self._sleep_or_stop(settings.RETENTION_SWEEP_INTERVAL_SECONDS)

    async def _vantage_status_loop(self) -> None:
        """Re-observe where each vantage point's traffic comes out.

        Slow on purpose. An exit changes when Tor rebuilds a circuit, not
        between one request and the next, and each pass costs one external
        request per vantage. Runs only where vantages are configured, so a
        deployment without them never reaches out to anything.
        """
        if not vantage_service.configured() or not settings.VANTAGE_ECHO_URL:
            return
        # Ahead of the first confirmations, so the resources page has something
        # to show rather than "not observed yet" for the first quarter hour.
        await self._sleep_or_stop(20)
        while not self._shutdown.is_set():
            try:
                async with SessionFactory() as session:
                    await vantage_service.refresh_status(
                        session, observed_by=self.worker_id
                    )
                    await session.commit()
            except Exception as exc:
                logger.warning("vantage_status_error", error=str(exc)[:200])
            await self._sleep_or_stop(settings.VANTAGE_STATUS_INTERVAL_SECONDS)

    async def _ssl_sweep_loop(self) -> None:
        """Keep certificate states current between checks.

        ``days_remaining`` is recomputed from the stored expiry, and expiry
        alerts are raised here as well - otherwise an endpoint on a one-hour
        interval could cross the warning threshold and stay silent until its
        next check.
        """
        await self._sleep_or_stop(45)
        while not self._shutdown.is_set():
            try:
                async with SessionFactory() as session:
                    config = await settings_service.load_settings(
                        session, use_cache=False
                    )
                    warning_days = int(config.get("ssl_warning_days", 30))
                    critical_days = int(config.get("ssl_critical_days", 7))
                    updated = await monitoring_service.regrade_certificates(
                        session,
                        warning_days=warning_days,
                        critical_days=critical_days,
                    )
                    await session.commit()

                    if config.get("alerts_enabled", True):
                        await self._raise_expiry_alerts(session, config)
                        await session.commit()

                    if updated:
                        logger.info("ssl_sweep_completed", regraded=updated)
            except Exception as exc:
                logger.error("ssl_sweep_error", error=str(exc))
            await self._sleep_or_stop(SSL_SWEEP_INTERVAL_SECONDS)

    async def _raise_expiry_alerts(self, session, config: dict) -> None:
        """Alert on certificates now inside a warning window.

        The alert cooldown keeps this from re-notifying every hour for the
        same certificate.
        """
        from app.core.enums import SslStatus
        from app.models.monitoring import SslCertificate

        alertable = (
            SslStatus.EXPIRING_SOON.value,
            SslStatus.CRITICAL.value,
            SslStatus.EXPIRED.value,
            SslStatus.INVALID.value,
        )
        rows = (
            await session.execute(
                select(SslCertificate, Endpoint)
                .join(Endpoint, Endpoint.id == SslCertificate.endpoint_id)
                .options(
                    selectinload(Endpoint.tags), selectinload(Endpoint.environment)
                )
                .where(
                    SslCertificate.is_current.is_(True),
                    SslCertificate.status.in_(alertable),
                    Endpoint.ssl_monitoring_enabled.is_(True),
                    Endpoint.alerts_enabled.is_(True),
                )
            )
        ).unique().all()

        for certificate, endpoint in rows:
            # Reuse the same evaluation the checker uses by adapting the row
            # into the shape evaluate_ssl_alert expects.
            info = _CertificateView(certificate)
            await alert_service.evaluate_ssl_alert(
                session, endpoint, info, config=config
            )

    async def _sleep_or_stop(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._shutdown.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            return

    # ----------------------------------------------------------- lifecycle
    async def run(self) -> None:
        self.install_signal_handlers()
        logger.info(
            "worker_started",
            worker_id=self.worker_id,
            concurrency=self.concurrency,
            poll_interval=settings.WORKER_POLL_INTERVAL_SECONDS,
            batch_size=settings.WORKER_BATCH_SIZE,
            version=settings.APP_VERSION,
        )

        tasks = [
            asyncio.create_task(self._heartbeat_loop(), name="heartbeat"),
            asyncio.create_task(self._check_loop(), name="checks"),
            asyncio.create_task(self._retention_loop(), name="retention"),
            asyncio.create_task(self._ssl_sweep_loop(), name="ssl-sweep"),
            asyncio.create_task(self._vantage_status_loop(), name="vantage-status"),
        ]

        try:
            await self._shutdown.wait()
        finally:
            logger.info(
                "worker_draining",
                in_flight=self._in_flight,
                screenshots_in_flight=len(self._screenshots),
                checks_completed=self._checks_completed,
            )
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

            # Renders get a few seconds to finish rather than being cancelled
            # outright: one is already most of the way through, and a captured
            # screenshot is worth more than a couple of seconds of shutdown.
            if self._screenshots:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(*self._screenshots, return_exceptions=True),
                        timeout=10,
                    )
                except asyncio.TimeoutError:
                    for task in list(self._screenshots):
                        task.cancel()
            await screenshot.shutdown()

            # Release anything still leased so a restart picks it up at once
            # rather than after the lease expires, and retire our own heartbeat
            # row in the same transaction. Deleting the row is what lets the
            # worker id be the container ID: a replaced container leaves no
            # orphan behind, so /health never counts a worker that has stopped.
            try:
                async with SessionFactory() as session:
                    await session.execute(
                        update(Endpoint)
                        .where(Endpoint.leased_by == self.worker_id)
                        .values(lease_expires_at=None, leased_by=None)
                    )
                    await session.execute(
                        delete(WorkerHeartbeat).where(
                            WorkerHeartbeat.worker_id == self.worker_id
                        )
                    )
                    await session.commit()
            except SQLAlchemyError as exc:  # pragma: no cover
                logger.warning("lease_cleanup_failed", error=str(exc))

            await dispose_engine()
            logger.info(
                "worker_stopped",
                worker_id=self.worker_id,
                checks_completed=self._checks_completed,
                checks_failed=self._checks_failed,
            )


class _CertificateView:
    """Adapter presenting a stored certificate row as a CertificateInfo.

    Lets the SSL sweep reuse the same alert evaluation as a live check without
    duplicating the message-building logic.
    """

    __slots__ = (
        "status",
        "days_remaining",
        "valid_to",
        "issuer_common_name",
        "issuer",
        "common_name",
        "verification_status",
        "verification_error",
        "error",
    )

    def __init__(self, row) -> None:
        self.status = row.status
        self.days_remaining = row.days_remaining
        self.valid_to = row.valid_to
        self.issuer_common_name = row.issuer_common_name
        self.issuer = row.issuer
        self.common_name = row.common_name
        self.verification_status = row.verification_status
        self.verification_error = row.verification_error
        self.error = None


async def main() -> None:
    if not settings.WORKER_ENABLED:
        logger.warning(
            "worker_disabled",
            detail="WORKER_ENABLED is false; exiting without monitoring anything",
        )
        return
    worker = MonitorWorker()
    await worker.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:  # pragma: no cover
        pass
