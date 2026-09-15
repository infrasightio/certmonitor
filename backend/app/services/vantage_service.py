"""Checking an endpoint from somewhere other than this host's own egress.

One VM, several exits. Each vantage point is a proxy the worker can reach - a
Tor SocksPort pinned to an exit country, a VPN container exposing SOCKS - so
the same check can leave by a different route and answer the question the local
check cannot: *is it down, or is it down from here?*

Three rules make this safe to build on free exits, which are slow, rate-limited
and frequently blocked:

1. **A verdict can only ever WITHHOLD an incident, never open one.** If the
   endpoint answers from Frankfurt while failing locally, the failure is more
   likely to be ours than theirs, so the incident waits. If no vantage can
   reach it either, nothing changes - the local check was already going to open
   the incident on its own.

2. **Inconclusive is not "down".** A Tor exit that is blocked by a WAF returns
   403, and a free VPN that is saturated times out. Neither says anything about
   the endpoint, so both are discarded rather than counted as agreement.

3. **A vantage never contributes a timing or an uptime figure.** It runs
   through a proxy, so its latency is the proxy's, and it runs only on failure,
   so counting it would skew availability toward whatever the exits happen to
   be doing. The local check remains the only measurement.

And one thing this deliberately does not claim: on a single VM the worker, the
kernel, the NIC and the availability zone are still shared. A vantage rules out
the egress path and the transit beyond it. It does not rule out the host.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import CheckType, FailureReason
from app.core.logging import get_logger
from app.monitoring.checker import CheckTarget, run_check
from app.models.endpoint import Endpoint
from app.models.monitoring import VantageStatus

logger = get_logger(__name__)

# Reasons a vantage result says nothing about the endpoint. A blocked or
# rate-limited exit is the normal case on free infrastructure, not a signal.
_INCONCLUSIVE_STATUSES = frozenset({403, 407, 429, 451, 503})

# Bounds how many confirmations run at once across the whole worker. Sized to
# leave the database pool alone: a confirmation holds the calling check's
# session while it waits on a slow exit.
_in_flight: asyncio.Semaphore | None = None


def _limit() -> asyncio.Semaphore:
    global _in_flight
    if _in_flight is None:
        _in_flight = asyncio.Semaphore(max(1, settings.VANTAGE_CONCURRENCY))
    return _in_flight


_INCONCLUSIVE_REASONS = frozenset(
    {
        # The proxy itself was unreachable or refused us, which is a fact about
        # the proxy.
        FailureReason.CONNECTION_REFUSED.value,
        FailureReason.CONNECTION_TIMEOUT.value,
        FailureReason.CONFIG_ERROR.value,
    }
)


@dataclass(frozen=True)
class VantagePoint:
    name: str
    proxy: str


@dataclass
class VantageResult:
    """What one vantage saw."""

    name: str
    reachable: bool | None = None  # None = inconclusive
    http_status_code: int | None = None
    detail: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "reachable": self.reachable,
            "http_status_code": self.http_status_code,
            "detail": self.detail,
        }


@dataclass
class VantageVerdict:
    """What the vantages collectively concluded about a local failure."""

    results: list[VantageResult] = field(default_factory=list)
    skipped_reason: str | None = None

    @property
    def reachable_elsewhere(self) -> bool:
        """Did anywhere else get through?

        Any single vantage succeeding is enough. The question being answered is
        "is the endpoint serving anyone at all", and one confirmed success
        settles it - requiring a majority would only mean free exits voting on
        something they have no opinion about.
        """
        return any(result.reachable is True for result in self.results)

    @property
    def conclusive(self) -> bool:
        return any(result.reachable is not None for result in self.results)

    def as_dict(self) -> dict[str, Any]:
        return {
            "reachable_elsewhere": self.reachable_elsewhere,
            "conclusive": self.conclusive,
            "skipped_reason": self.skipped_reason,
            "results": [result.as_dict() for result in self.results],
        }


def configured() -> list[VantagePoint]:
    """The vantage points from the environment, or an empty list.

    Never raises on bad configuration: a typo in an environment variable must
    not stop the monitor from monitoring. It is logged once and ignored.
    """
    raw = (settings.VANTAGE_POINTS or "").strip()
    if not raw or not settings.VANTAGE_ENABLED:
        return []
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        logger.warning("vantage_points_invalid", error=str(exc)[:200])
        return []
    if not isinstance(parsed, list):
        logger.warning("vantage_points_invalid", error="expected a JSON list")
        return []

    points: list[VantagePoint] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        proxy = str(entry.get("proxy") or "").strip()
        if not proxy:
            continue
        points.append(
            VantagePoint(
                name=str(entry.get("name") or proxy)[:64],
                proxy=proxy,
            )
        )
    return points


async def _resolves_privately(hostname: str) -> bool:
    """Does this hostname point somewhere only this network can reach?

    An internal service is unreachable from an external exit by definition, so
    asking one would produce a guaranteed failure and a meaningless verdict.
    Resolution failure counts as private: if we cannot resolve it here, a
    vantage almost certainly cannot either.

    Resolved through the event loop rather than with a bare
    ``socket.getaddrinfo``: this runs on the worker's loop with a database
    session open, and a blocking lookup against a slow resolver would stall
    every other check in flight, not just this one.
    """
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(hostname, None)
    except (OSError, socket.gaierror):
        return True
    for info in infos:
        address = info[4][0]
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if parsed.is_global:
            return False
    return True


def _classify(outcome: Any) -> tuple[bool | None, str | None]:
    """Turn one proxied check into reachable / not / inconclusive."""
    if outcome.is_up:
        return True, None

    status = outcome.http_status_code
    if status in _INCONCLUSIVE_STATUSES:
        # The exit was blocked or throttled, which is about the exit.
        return None, f"exit blocked or throttled (HTTP {status})"
    if status is not None:
        # A real answer from the origin, just not the expected one. That is
        # agreement: the endpoint is serving something wrong to everyone.
        return False, f"HTTP {status}"
    if outcome.failure_reason in _INCONCLUSIVE_REASONS:
        return None, outcome.error_message or "the exit could not be used"
    return False, outcome.error_message or outcome.failure_reason


async def _probe(point: VantagePoint, target: CheckTarget) -> VantageResult:
    try:
        outcome = await run_check(target)
    except Exception as exc:  # pragma: no cover - defensive
        return VantageResult(name=point.name, reachable=None, detail=str(exc)[:200])
    reachable, detail = _classify(outcome)
    return VantageResult(
        name=point.name,
        reachable=reachable,
        http_status_code=outcome.http_status_code,
        detail=detail,
    )


async def confirm(endpoint: Endpoint, config: dict[str, Any]) -> VantageVerdict:
    """Ask every configured vantage whether it can reach this endpoint.

    Only ever called on a check that would otherwise open an incident, so the
    cost is a handful of proxied requests at the moment an outage starts rather
    than on every check.
    """
    points = configured()
    if not points:
        return VantageVerdict(skipped_reason="No vantage points are configured.")
    if endpoint.check_type != CheckType.HTTP.value:
        return VantageVerdict(
            skipped_reason="Only HTTP checks can be confirmed from a vantage point."
        )
    if await _resolves_privately(endpoint.hostname):
        return VantageVerdict(
            skipped_reason=(
                f"{endpoint.hostname} resolves to a private address, which an "
                "external exit cannot reach."
            )
        )

    # Non-blocking, and skipped rather than queued when busy. This runs with
    # the check's database session still open, so the cost has to be bounded
    # in the one case that matters: a large outage, where many endpoints reach
    # their threshold at once. At most VANTAGE_CONCURRENCY confirmations are
    # ever in flight; the rest fall straight through to today's behaviour and
    # open their incident. Withholding an alert because a proxy was busy would
    # be the worst possible failure mode for a monitor.
    limit = _limit()
    if limit.locked():
        return VantageVerdict(skipped_reason="Vantage points were busy.")

    async def _one(point: VantagePoint) -> VantageResult:
        async with limit:
            target = CheckTarget(
                url=endpoint.url,
                hostname=endpoint.hostname,
                port=endpoint.port,
                protocol=endpoint.protocol,
                check_type=CheckType.HTTP.value,
                http_method=endpoint.http_method,
                timeout_seconds=settings.VANTAGE_TIMEOUT_SECONDS,
                expected_status_codes=endpoint.expected_status_list,
                follow_redirects=endpoint.follow_redirects,
                verify_ssl=endpoint.verify_ssl,
                # Nothing here needs a certificate: the local check already
                # inspected it, and doing it again over a slow exit only adds
                # time to a decision that is holding up an alert.
                ssl_monitoring_enabled=False,
                proxy=point.proxy,
            )
            return await _probe(point, target)

    # Hard ceiling on the whole round, not just on each request. A vantage that
    # hangs past this is abandoned and the incident opens normally - the same
    # fail-open rule as the busy case above.
    try:
        results = await asyncio.wait_for(
            asyncio.gather(*(_one(point) for point in points)),
            timeout=settings.VANTAGE_TIMEOUT_SECONDS + 5,
        )
    except asyncio.TimeoutError:
        logger.info("vantage_confirmation_timed_out", endpoint=endpoint.name)
        return VantageVerdict(skipped_reason="Vantage points did not answer in time.")
    verdict = VantageVerdict(results=list(results))

    logger.info(
        "vantage_confirmation",
        endpoint=endpoint.name,
        reachable_elsewhere=verdict.reachable_elsewhere,
        conclusive=verdict.conclusive,
        vantages=len(results),
    )
    return verdict


# ------------------------------------------------------- observing the exits
async def _observe(point: VantagePoint) -> dict[str, Any]:
    """Ask a vantage where its traffic comes out.

    One request to an echo service through the proxy. The answer is what makes
    a vantage's name checkable rather than merely asserted - with
    ``StrictNodes 0``, a vantage labelled "Germany" will quietly answer from
    somewhere else whenever no German exit is available, and without this
    nothing would ever say so.
    """
    import httpx

    from app.monitoring import transport as transport_module

    client = transport_module.build_async_client(
        verify=True,
        timeout=float(settings.VANTAGE_TIMEOUT_SECONDS),
        follow_redirects=True,
        proxy=point.proxy,
    )
    try:
        response = await client.get(settings.VANTAGE_ECHO_URL)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        detail = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
        return {"reachable": False, "error": detail[:255]}
    finally:
        await client.aclose()

    if not isinstance(payload, dict):
        return {"reachable": False, "error": "The echo service returned no detail."}

    # Field names differ between echo services, so the common spellings are
    # accepted rather than pinning this to one provider.
    def _first(*names: str) -> str | None:
        for name in names:
            value = payload.get(name)
            if value:
                return str(value)[:64]
        return None

    return {
        "reachable": True,
        "observed_ip": _first("ip", "query", "ip_addr", "origin"),
        "observed_country": (_first("country_iso", "country_code", "countryCode", "country") or "")[:8]
        or None,
        "observed_city": _first("city"),
        "error": None,
    }


async def refresh_status(session: AsyncSession, *, observed_by: str | None = None) -> int:
    """Re-observe every configured vantage and record what it saw.

    Called on a slow loop by the worker, not per check: an exit's location
    changes when Tor rebuilds a circuit, not between one request and the next,
    and this costs an external request per vantage each time.

    Rows for vantages that are no longer configured are removed, so the table
    follows the configuration rather than accumulating names nobody uses.
    """
    points = configured()
    now = datetime.now(timezone.utc)

    names = [point.name for point in points]
    if names:
        await session.execute(
            delete(VantageStatus).where(VantageStatus.name.not_in(names))
        )
    else:
        await session.execute(delete(VantageStatus))
        await session.flush()
        return 0

    observations = await asyncio.gather(
        *(_observe(point) for point in points), return_exceptions=True
    )

    for point, observed in zip(points, observations):
        if isinstance(observed, BaseException):
            observed = {"reachable": False, "error": str(observed)[:255]}

        row = (
            await session.execute(
                select(VantageStatus).where(VantageStatus.name == point.name)
            )
        ).scalar_one_or_none()
        if row is None:
            row = VantageStatus(name=point.name)
            session.add(row)

        row.proxy = point.proxy[:255]
        row.reachable = bool(observed.get("reachable"))
        row.observed_ip = observed.get("observed_ip")
        row.observed_country = observed.get("observed_country")
        row.observed_city = observed.get("observed_city")
        row.error = observed.get("error")
        row.checked_at = now
        row.observed_by = (observed_by or "")[:64] or None

    await session.flush()
    logger.info("vantage_status_refreshed", vantages=len(points))
    return len(points)


async def current_status(session: AsyncSession) -> list[VantageStatus]:
    """Every configured vantage, whether or not it has been observed yet."""
    rows = {
        row.name: row
        for row in (
            await session.execute(select(VantageStatus).order_by(VantageStatus.name))
        ).scalars().all()
    }
    # Driven by the configuration, so a vantage that has never answered still
    # appears - "configured but never reached" is the most important state this
    # screen can show, and a missing row would render as nothing at all.
    result: list[VantageStatus] = []
    for point in configured():
        row = rows.get(point.name)
        if row is None:
            row = VantageStatus(
                name=point.name,
                proxy=point.proxy[:255],
                reachable=False,
                error="Not observed yet.",
                checked_at=datetime.now(timezone.utc),
            )
        result.append(row)
    return result
