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
