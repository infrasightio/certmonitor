"""Checking from somewhere other than this host before declaring an endpoint down.

The safety property these exist to hold: a vantage point can only ever WITHHOLD
an incident, never open one, and anything short of a confident "reachable from
elsewhere" leaves the monitor behaving exactly as it did before. A monitor that
swallows an alert because a free proxy was slow is worse than one with no
vantage points at all.
"""

from __future__ import annotations

import json

import pytest

from app.core.enums import CheckStatus, FailureReason
from app.monitoring.checker import CheckOutcome
from app.services import vantage_service
from app.services.vantage_service import (
    VantagePoint,
    VantageResult,
    VantageVerdict,
)


def probe(
    *,
    up: bool = False,
    status: int | None = None,
    reason: str = FailureReason.CONNECTION_TIMEOUT.value,
    error: str | None = None,
) -> CheckOutcome:
    outcome = CheckOutcome()
    outcome.status = CheckStatus.UP.value if up else CheckStatus.DOWN.value
    outcome.http_status_code = status
    outcome.failure_reason = FailureReason.NONE.value if up else reason
    outcome.error_message = error
    return outcome


class TestVerdict:
    def test_one_reachable_vantage_is_enough(self):
        """The question is whether the endpoint is serving anyone at all, and
        one confirmed success settles it."""
        verdict = VantageVerdict(
            results=[
                VantageResult(name="Germany", reachable=True),
                VantageResult(name="Singapore", reachable=False),
                VantageResult(name="United States", reachable=None),
            ]
        )
        assert verdict.reachable_elsewhere is True

    def test_agreement_does_not_withhold(self):
        """Nowhere could reach it, so the incident opens as it would have."""
        verdict = VantageVerdict(
            results=[
                VantageResult(name="Germany", reachable=False),
                VantageResult(name="Singapore", reachable=False),
            ]
        )
        assert verdict.reachable_elsewhere is False

    def test_all_inconclusive_withholds_nothing(self):
        """Three blocked exits are three non-answers, not a vote."""
        verdict = VantageVerdict(
            results=[
                VantageResult(name="Germany", reachable=None),
                VantageResult(name="Singapore", reachable=None),
            ]
        )
        assert verdict.reachable_elsewhere is False
        assert verdict.conclusive is False

    def test_a_skipped_round_withholds_nothing(self):
        assert VantageVerdict(skipped_reason="busy").reachable_elsewhere is False


class TestClassification:
    def test_a_successful_probe_is_reachable(self):
        reachable, _ = vantage_service._classify(probe(up=True, status=200))
        assert reachable is True

    @pytest.mark.parametrize("status", [403, 407, 429, 451, 503])
    def test_a_blocked_exit_says_nothing(self, status):
        """Tor exits and free VPN ranges are routinely blocked by WAFs and
        CDNs. That is a fact about the exit, not about the endpoint."""
        reachable, detail = vantage_service._classify(probe(status=status))
        assert reachable is None
        assert "exit" in detail

    def test_a_real_wrong_answer_is_agreement(self):
        """A 500 from the origin reached the origin - the endpoint is serving
        something broken to everyone, which confirms the local failure."""
        reachable, _ = vantage_service._classify(probe(status=500))
        assert reachable is False

    @pytest.mark.parametrize(
        "reason",
        [
            FailureReason.CONNECTION_REFUSED.value,
            FailureReason.CONNECTION_TIMEOUT.value,
            FailureReason.CONFIG_ERROR.value,
        ],
    )
    def test_an_unusable_proxy_says_nothing(self, reason):
        reachable, _ = vantage_service._classify(probe(reason=reason))
        assert reachable is None

    def test_dns_failure_from_the_exit_is_agreement(self):
        """The exit worked and the name did not resolve for it either."""
        reachable, _ = vantage_service._classify(
            probe(reason=FailureReason.DNS_FAILURE.value, error="NXDOMAIN")
        )
        assert reachable is False


class TestConfiguration:
    def test_no_configuration_means_no_vantages(self, monkeypatch):
        monkeypatch.setattr(vantage_service.settings, "VANTAGE_POINTS", "")
        assert vantage_service.configured() == []

    def test_malformed_json_is_ignored_not_raised(self, monkeypatch):
        """A typo in an environment variable must not stop the monitor from
        monitoring."""
        monkeypatch.setattr(
            vantage_service.settings, "VANTAGE_POINTS", "{not json at all"
        )
        monkeypatch.setattr(vantage_service.settings, "VANTAGE_ENABLED", True)
        assert vantage_service.configured() == []

    def test_entries_without_a_proxy_are_dropped(self, monkeypatch):
        monkeypatch.setattr(
            vantage_service.settings,
            "VANTAGE_POINTS",
            json.dumps([{"name": "Nowhere"}, {"name": "Germany", "proxy": "socks5://t:9050"}]),
        )
        monkeypatch.setattr(vantage_service.settings, "VANTAGE_ENABLED", True)
        points = vantage_service.configured()
        assert points == [VantagePoint(name="Germany", proxy="socks5://t:9050")]

    def test_the_kill_switch_wins(self, monkeypatch):
        monkeypatch.setattr(
            vantage_service.settings,
            "VANTAGE_POINTS",
            json.dumps([{"name": "Germany", "proxy": "socks5://t:9050"}]),
        )
        monkeypatch.setattr(vantage_service.settings, "VANTAGE_ENABLED", False)
        assert vantage_service.configured() == []


class TestInternalEndpoints:
    async def test_a_private_endpoint_is_skipped(
        self, endpoint_factory, runtime_config, monkeypatch
    ):
        """An external exit cannot reach an internal service, so asking one
        would produce a guaranteed failure and a meaningless verdict."""
        monkeypatch.setattr(
            vantage_service.settings,
            "VANTAGE_POINTS",
            json.dumps([{"name": "Germany", "proxy": "socks5://t:9050"}]),
        )
        monkeypatch.setattr(vantage_service.settings, "VANTAGE_ENABLED", True)

        async def _private(hostname):
            return True

        monkeypatch.setattr(vantage_service, "_resolves_privately", _private)

        endpoint = await endpoint_factory(url="https://internal.example.com/health")
        verdict = await vantage_service.confirm(endpoint, runtime_config)

        assert verdict.results == []
        assert "private address" in verdict.skipped_reason
        assert verdict.reachable_elsewhere is False

    async def test_a_tcp_check_is_skipped(
        self, endpoint_factory, runtime_config, monkeypatch
    ):
        monkeypatch.setattr(
            vantage_service.settings,
            "VANTAGE_POINTS",
            json.dumps([{"name": "Germany", "proxy": "socks5://t:9050"}]),
        )
        monkeypatch.setattr(vantage_service.settings, "VANTAGE_ENABLED", True)

        endpoint = await endpoint_factory(
            url="https://db.example.com:5432", check_type="tcp"
        )
        verdict = await vantage_service.confirm(endpoint, runtime_config)

        assert verdict.results == []
        assert "HTTP" in verdict.skipped_reason


class TestIncidentWithholding:
    """record_check_result's side of the contract."""

    async def test_an_incident_is_withheld_when_asked(
        self, session, endpoint_factory, runtime_config
    ):
        from app.services import monitoring_service

        endpoint = await endpoint_factory()
        threshold = runtime_config["failure_threshold"]

        for index in range(threshold):
            last = index == threshold - 1
            recorded = await monitoring_service.record_check_result(
                session,
                endpoint,
                probe(reason=FailureReason.CONNECTION_TIMEOUT.value),
                config=runtime_config,
                withhold_incident_reason=(
                    "Reachable from Germany." if last else None
                ),
                dispatch_notifications=False,
            )
        await session.commit()

        # The endpoint still reads as down - it is, from here - but nobody was
        # paged and no incident exists.
        assert endpoint.current_status == "down"
        assert endpoint.consecutive_failures == threshold
        assert recorded.incident_opened is None
        assert recorded.incident_withheld_reason == "Reachable from Germany."
        assert recorded.alerts_raised == []

    async def test_the_incident_opens_on_the_next_unexplained_failure(
        self, session, endpoint_factory, runtime_config
    ):
        from app.services import monitoring_service

        endpoint = await endpoint_factory()
        threshold = runtime_config["failure_threshold"]

        for _ in range(threshold):
            await monitoring_service.record_check_result(
                session,
                endpoint,
                probe(),
                config=runtime_config,
                withhold_incident_reason="Reachable from Germany.",
                dispatch_notifications=False,
            )

        # The next one is not explained away.
        recorded = await monitoring_service.record_check_result(
            session,
            endpoint,
            probe(),
            config=runtime_config,
            dispatch_notifications=False,
        )
        await session.commit()

        assert recorded.incident_opened is not None

    async def test_without_a_reason_nothing_changes(
        self, session, endpoint_factory, runtime_config
    ):
        """The default path is byte-for-byte today's behaviour."""
        from app.services import monitoring_service

        endpoint = await endpoint_factory()
        threshold = runtime_config["failure_threshold"]

        for _ in range(threshold):
            recorded = await monitoring_service.record_check_result(
                session,
                endpoint,
                probe(),
                config=runtime_config,
                dispatch_notifications=False,
            )
        await session.commit()

        assert recorded.incident_opened is not None
        assert recorded.incident_withheld_reason is None


class TestObservedStatus:
    """Turning the label into a fact.

    The name in VANTAGE_POINTS is something somebody typed. Tor runs with
    StrictNodes 0 so it falls back to another country rather than failing, so a
    vantage labelled "Germany" can quietly answer from elsewhere - and without
    an observed exit recorded beside the name, nothing would ever say so.
    """

    @staticmethod
    def _configure(monkeypatch, names):
        monkeypatch.setattr(vantage_service.settings, "VANTAGE_ENABLED", True)
        monkeypatch.setattr(
            vantage_service.settings,
            "VANTAGE_POINTS",
            json.dumps(
                [{"name": name, "proxy": f"socks5://{name}:9050"} for name in names]
            ),
        )

    async def test_an_unobserved_vantage_still_appears(
        self, session, monkeypatch
    ):
        """"Configured but never reached" is the most useful state this screen
        can report, and a missing row would render as nothing at all."""
        self._configure(monkeypatch, ["Germany"])

        rows = await vantage_service.current_status(session)

        assert [row.name for row in rows] == ["Germany"]
        assert rows[0].reachable is False
        assert rows[0].error == "Not observed yet."

    async def test_the_observation_is_recorded(self, session, monkeypatch):
        self._configure(monkeypatch, ["Germany"])

        async def _observe(point):
            return {
                "reachable": True,
                "observed_ip": "85.214.10.20",
                "observed_country": "DE",
                "observed_city": "Frankfurt",
                "error": None,
            }

        monkeypatch.setattr(vantage_service, "_observe", _observe)
        assert await vantage_service.refresh_status(session, observed_by="w1") == 1
        await session.commit()

        rows = await vantage_service.current_status(session)
        assert rows[0].observed_country == "DE"
        assert rows[0].observed_ip == "85.214.10.20"
        assert rows[0].reachable is True
        assert rows[0].observed_by == "w1"

    async def test_an_unreachable_exit_records_why(self, session, monkeypatch):
        self._configure(monkeypatch, ["Germany"])

        async def _observe(point):
            return {"reachable": False, "error": "All exits are down."}

        monkeypatch.setattr(vantage_service, "_observe", _observe)
        await vantage_service.refresh_status(session)
        await session.commit()

        rows = await vantage_service.current_status(session)
        assert rows[0].reachable is False
        assert rows[0].error == "All exits are down."

    async def test_a_raising_observation_does_not_lose_the_round(
        self, session, monkeypatch
    ):
        """One broken proxy must not stop the other vantages being recorded."""
        self._configure(monkeypatch, ["Germany", "Singapore"])

        async def _observe(point):
            if point.name == "Germany":
                raise RuntimeError("socket blew up")
            return {"reachable": True, "observed_country": "SG"}

        monkeypatch.setattr(vantage_service, "_observe", _observe)
        await vantage_service.refresh_status(session)
        await session.commit()

        rows = {row.name: row for row in await vantage_service.current_status(session)}
        assert rows["Germany"].reachable is False
        assert rows["Singapore"].observed_country == "SG"

    async def test_rows_follow_the_configuration(self, session, monkeypatch):
        """A vantage removed from the environment should not linger on the
        resources page as something that still exists."""
        self._configure(monkeypatch, ["Germany", "Singapore"])

        async def _observe(point):
            return {"reachable": True, "observed_country": "XX"}

        monkeypatch.setattr(vantage_service, "_observe", _observe)
        await vantage_service.refresh_status(session)
        await session.commit()
        assert len(await vantage_service.current_status(session)) == 2

        self._configure(monkeypatch, ["Germany"])
        await vantage_service.refresh_status(session)
        await session.commit()

        rows = await vantage_service.current_status(session)
        assert [row.name for row in rows] == ["Germany"]

    async def test_removing_every_vantage_clears_the_table(
        self, session, monkeypatch
    ):
        self._configure(monkeypatch, ["Germany"])

        async def _observe(point):
            return {"reachable": True, "observed_country": "DE"}

        monkeypatch.setattr(vantage_service, "_observe", _observe)
        await vantage_service.refresh_status(session)
        await session.commit()

        monkeypatch.setattr(vantage_service.settings, "VANTAGE_POINTS", "")
        assert await vantage_service.refresh_status(session) == 0
        await session.commit()

        assert await vantage_service.current_status(session) == []


class TestWorkerRegion:
    async def test_the_region_is_reported_with_the_fleet(
        self, client, admin_headers, session
    ):
        """What the resources page reads to say which worker is where."""
        from datetime import datetime, timezone

        from app.models.monitoring import WorkerHeartbeat

        now = datetime.now(timezone.utc)
        session.add(
            WorkerHeartbeat(
                worker_id="worker-a",
                started_at=now,
                last_seen_at=now,
                region="ap-south-1b",
                hostname="box-a",
            )
        )
        await session.commit()

        response = await client.get("/api/workers", headers=admin_headers)
        assert response.status_code == 200, response.text
        rows = {row["worker_id"]: row for row in response.json()}
        assert rows["worker-a"]["region"] == "ap-south-1b"

    async def test_a_worker_without_a_region_reports_none(
        self, client, admin_headers, session
    ):
        """Empty on a single-worker deployment, where the answer is "the one
        box" - not the string "unknown" for the UI to special-case."""
        from datetime import datetime, timezone

        from app.models.monitoring import WorkerHeartbeat

        now = datetime.now(timezone.utc)
        session.add(
            WorkerHeartbeat(worker_id="worker-b", started_at=now, last_seen_at=now)
        )
        await session.commit()

        response = await client.get("/api/workers", headers=admin_headers)
        rows = {row["worker_id"]: row for row in response.json()}
        assert rows["worker-b"]["region"] is None
