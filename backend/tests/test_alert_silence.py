"""Silencing an endpoint: alerts off, monitoring on.

Pausing was the only way to stop an endpoint paging people, and it stops the
checks as well - so an afternoon of known noise cost the results, the
incidents and the uptime figure for the period, which is usually the data
wanted afterwards. A silence stops only the delivery.

Two promises are worth pinning down, because breaking either makes the
feature dangerous rather than useful: while silenced nothing is delivered,
and everything else carries on exactly as before.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.core.enums import AlertType
from app.services import alert_service, notification_service


@pytest.fixture
def dispatched(monkeypatch):
    """Capture what would have been delivered, without delivering it."""
    calls = []

    async def _fake(session, alert, *, config=None):
        calls.append(alert)
        return {"delivered": 1, "failed": 0, "channels": []}

    monkeypatch.setattr(notification_service, "dispatch_alert", _fake)
    return calls


async def _raise(session, endpoint, config, alert_type=AlertType.ENDPOINT_DOWN.value):
    return await alert_service.raise_alert(
        session,
        alert_type=alert_type,
        endpoint=endpoint,
        title=f"Endpoint DOWN: {endpoint.name}",
        message="It stopped answering.",
        config=config,
    )


class TestTheProperty:
    async def test_an_endpoint_is_not_silenced_by_default(self, endpoint_factory):
        endpoint = await endpoint_factory()
        assert endpoint.is_silenced is False

    async def test_a_future_window_is_a_silence(self, endpoint_factory):
        endpoint = await endpoint_factory()
        endpoint.silenced_until = datetime.now(timezone.utc) + timedelta(minutes=30)
        assert endpoint.is_silenced is True

    async def test_a_lapsed_window_is_not(self, endpoint_factory):
        """The silence ends by itself.

        Nothing runs to clear the timestamp, so if this were true for a past
        date a forgotten silence would be permanent.
        """
        endpoint = await endpoint_factory()
        endpoint.silenced_until = datetime.now(timezone.utc) - timedelta(seconds=1)
        assert endpoint.is_silenced is False


class TestDelivery:
    async def test_an_audible_endpoint_is_delivered(
        self, session, endpoint_factory, runtime_config, dispatched
    ):
        """The control: without this the tests below prove nothing."""
        endpoint = await endpoint_factory()
        alert = await _raise(session, endpoint, runtime_config)

        assert alert is not None
        assert len(dispatched) == 1
        assert alert.notification_status != "skipped"

    async def test_a_silenced_endpoint_is_not_delivered(
        self, session, endpoint_factory, runtime_config, dispatched
    ):
        endpoint = await endpoint_factory()
        endpoint.silenced_until = datetime.now(timezone.utc) + timedelta(hours=1)
        endpoint.silence_reason = "Deploying"
        await session.commit()

        alert = await _raise(session, endpoint, runtime_config)

        assert dispatched == []
        assert alert is not None, "the alert must still be recorded"
        assert alert.notification_status == "skipped"
        assert "silenced" in (alert.notification_error or "")
        assert "Deploying" in (alert.notification_error or "")

    async def test_the_recovery_notice_is_silenced_too(
        self, session, endpoint_factory, runtime_config, dispatched
    ):
        """An endpoint nobody wants to hear from is one they do not want the
        all-clear from either - and a recovery notice is exempt from the
        cooldown, so without this it would be the one thing that got through.
        """
        endpoint = await endpoint_factory()
        endpoint.silenced_until = datetime.now(timezone.utc) + timedelta(hours=1)
        await session.commit()

        alert = await _raise(
            session, endpoint, runtime_config, AlertType.ENDPOINT_RECOVERED.value
        )

        assert dispatched == []
        assert alert.notification_status == "skipped"

    async def test_a_lapsed_silence_delivers_again(
        self, session, endpoint_factory, runtime_config, dispatched
    ):
        endpoint = await endpoint_factory()
        endpoint.silenced_until = datetime.now(timezone.utc) - timedelta(minutes=1)
        endpoint.silence_reason = "Deploying, an hour ago"
        await session.commit()

        await _raise(session, endpoint, runtime_config)

        assert len(dispatched) == 1


class TestApi:
    async def test_silencing_records_who_why_and_until_when(
        self, client, admin_headers, endpoint_factory
    ):
        endpoint = await endpoint_factory()
        response = await client.post(
            f"/api/endpoints/{endpoint.id}/silence",
            json={"minutes": 60, "reason": "Deploying v2"},
            headers=admin_headers,
        )

        assert response.status_code == 200
        body = response.json()
        assert body["is_silenced"] is True
        assert body["silence_reason"] == "Deploying v2"
        assert body["silenced_by"] == "admin"
        assert body["silenced_until"] is not None

    async def test_silencing_does_not_touch_the_monitoring(
        self, client, admin_headers, session, endpoint_factory
    ):
        """The entire point.

        Pausing clears next_check_at and sets the status to paused; a silence
        must leave both alone, or it is a pause with a friendlier name.
        """
        endpoint = await endpoint_factory()
        before_due = endpoint.next_check_at
        before_status = endpoint.current_status

        await client.post(
            f"/api/endpoints/{endpoint.id}/silence",
            json={"minutes": 60, "reason": "Deploying v2"},
            headers=admin_headers,
        )
        await session.refresh(endpoint)

        assert endpoint.next_check_at == before_due
        assert endpoint.current_status == before_status
        assert endpoint.is_paused is False
        assert endpoint.monitoring_enabled is True
        # The permanent switch is a different setting, and a temporary one
        # must not touch it.
        assert endpoint.alerts_enabled is True

    async def test_unsilencing_clears_the_whole_record(
        self, client, admin_headers, endpoint_factory
    ):
        """A leftover reason on an audible endpoint reads as a silence still
        in force.
        """
        endpoint = await endpoint_factory()
        await client.post(
            f"/api/endpoints/{endpoint.id}/silence",
            json={"minutes": 60, "reason": "Deploying v2"},
            headers=admin_headers,
        )

        response = await client.delete(
            f"/api/endpoints/{endpoint.id}/silence", headers=admin_headers
        )

        assert response.status_code == 200
        body = response.json()
        assert body["is_silenced"] is False
        assert body["silenced_until"] is None
        assert body["silence_reason"] is None
        assert body["silenced_by"] is None

    async def test_unsilencing_something_audible_is_not_an_error(
        self, client, admin_headers, endpoint_factory
    ):
        """The caller wants it audible, and it is."""
        endpoint = await endpoint_factory()
        response = await client.delete(
            f"/api/endpoints/{endpoint.id}/silence", headers=admin_headers
        )

        assert response.status_code == 200
        assert response.json()["is_silenced"] is False

    async def test_a_reason_is_required(self, client, admin_headers, endpoint_factory):
        endpoint = await endpoint_factory()
        response = await client.post(
            f"/api/endpoints/{endpoint.id}/silence",
            json={"minutes": 60, "reason": "  "},
            headers=admin_headers,
        )

        assert response.status_code == 422

    @pytest.mark.parametrize("minutes", [1, 20_000])
    async def test_the_window_is_bounded(
        self, client, admin_headers, endpoint_factory, minutes
    ):
        """Below the floor it is pointless; above the ceiling it becomes the
        reason nobody heard about an outage. Permanent belongs in
        alerts_enabled.
        """
        endpoint = await endpoint_factory()
        response = await client.post(
            f"/api/endpoints/{endpoint.id}/silence",
            json={"minutes": minutes, "reason": "Deploying v2"},
            headers=admin_headers,
        )

        assert response.status_code == 422

    async def test_re_silencing_replaces_the_window(
        self, client, admin_headers, endpoint_factory
    ):
        """Silencing it "for another 30 minutes" means 30 minutes from now,
        not 30 added to what was left.
        """
        endpoint = await endpoint_factory()
        first = await client.post(
            f"/api/endpoints/{endpoint.id}/silence",
            json={"minutes": 1440, "reason": "Deploying v2"},
            headers=admin_headers,
        )
        second = await client.post(
            f"/api/endpoints/{endpoint.id}/silence",
            json={"minutes": 30, "reason": "Nearly done"},
            headers=admin_headers,
        )

        assert second.json()["silenced_until"] < first.json()["silenced_until"]
        assert second.json()["silence_reason"] == "Nearly done"

    async def test_a_viewer_cannot_silence(
        self, client, viewer_headers, endpoint_factory
    ):
        endpoint = await endpoint_factory()
        response = await client.post(
            f"/api/endpoints/{endpoint.id}/silence",
            json={"minutes": 60, "reason": "Not mine to silence"},
            headers=viewer_headers,
        )

        assert response.status_code == 403
