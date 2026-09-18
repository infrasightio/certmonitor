"""Incident API: acknowledgement, and who did it.

"Acknowledged" without a name is a record of nothing - the point of
acknowledging is that a specific person took it. The detail route resolved
the username but the list route did not, so a acknowledged incident showed
no owner anywhere the operator actually looks.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models.incident import Incident


@pytest.fixture
async def incident(session, seeded, endpoint_factory):
    """An open incident to acknowledge."""
    endpoint = await endpoint_factory(
        name="Payments API", url="https://payments.example.com/health"
    )
    started = datetime.now(timezone.utc) - timedelta(minutes=20)
    row = Incident(
        endpoint_id=endpoint.id,
        status="open",
        severity="critical",
        started_at=started,
        reason="connection_timeout",
        error_message="Connection timeout",
        failed_check_count=3,
    )
    session.add(row)
    await session.commit()
    return row


class TestAcknowledgement:
    async def test_acknowledging_records_the_user(
        self, client, admin_headers, incident
    ):
        response = await client.patch(
            f"/api/incidents/{incident.id}",
            json={"acknowledge": True},
            headers=admin_headers,
        )

        assert response.status_code == 200
        body = response.json()
        assert body["acknowledged_by"] == "admin"
        assert body["acknowledged_at"] is not None

    async def test_the_detail_route_reports_who_acknowledged(
        self, client, admin_headers, incident
    ):
        await client.patch(
            f"/api/incidents/{incident.id}",
            json={"acknowledge": True},
            headers=admin_headers,
        )

        response = await client.get(
            f"/api/incidents/{incident.id}", headers=admin_headers
        )

        assert response.json()["acknowledged_by"] == "admin"

    async def test_the_list_route_reports_who_acknowledged(
        self, client, admin_headers, incident
    ):
        """The list is where an operator scans for unowned incidents."""
        await client.patch(
            f"/api/incidents/{incident.id}",
            json={"acknowledge": True},
            headers=admin_headers,
        )

        response = await client.get("/api/incidents", headers=admin_headers)

        rows = response.json()["items"]
        assert len(rows) == 1
        assert rows[0]["acknowledged_by"] == "admin"
        assert rows[0]["acknowledged_at"] is not None

    async def test_an_unacknowledged_incident_names_nobody(
        self, client, admin_headers, incident
    ):
        response = await client.get("/api/incidents", headers=admin_headers)

        row = response.json()["items"][0]
        assert row["acknowledged_by"] is None
        assert row["acknowledged_at"] is None

    async def test_un_acknowledging_clears_the_user(
        self, client, admin_headers, incident
    ):
        await client.patch(
            f"/api/incidents/{incident.id}",
            json={"acknowledge": True},
            headers=admin_headers,
        )

        response = await client.patch(
            f"/api/incidents/{incident.id}",
            json={"acknowledge": False},
            headers=admin_headers,
        )

        assert response.json()["acknowledged_by"] is None
        assert response.json()["acknowledged_at"] is None

    async def test_a_viewer_cannot_acknowledge(
        self, client, viewer_headers, incident
    ):
        """Acknowledging is a claim of ownership, so it needs incident:write."""
        response = await client.patch(
            f"/api/incidents/{incident.id}",
            json={"acknowledge": True},
            headers=viewer_headers,
        )

        assert response.status_code == 403


class TestManualResolution:
    """Closing an incident without waiting for a successful check.

    The worker owns resolution from observed state, and that leaves incidents
    it can never close: an endpoint paused or retired while down is never
    checked again, so its incident stays open forever. This is the way out,
    and the tests below pin the two things that make it safe to have - it is
    recorded as a decision rather than a recovery, and it silences nothing.
    """

    async def test_resolving_records_the_user_and_the_reason(
        self, client, admin_headers, incident
    ):
        response = await client.post(
            f"/api/incidents/{incident.id}/resolve",
            json={"note": "Endpoint retired; tracked under CHG-104."},
            headers=admin_headers,
        )

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "resolved"
        assert body["resolved_at"] is not None
        assert body["resolved_by"] == "admin"
        assert body["resolution_note"] == "Endpoint retired; tracked under CHG-104."
        # Twenty minutes of outage, from the fixture's started_at.
        assert 1100 < body["duration_seconds"] < 1300

    async def test_it_does_not_invent_a_recovery(
        self, client, admin_headers, incident
    ):
        """`_close_incident` fills these from the check that proved the
        endpoint was working. There is no such check here, and a status code
        no check produced would be a measurement inside a decision."""
        response = await client.post(
            f"/api/incidents/{incident.id}/resolve",
            json={"note": "Handled out of band."},
            headers=admin_headers,
        )

        body = response.json()
        assert body["recovery_status_code"] is None
        assert body["recovery_response_time_ms"] is None

    async def test_the_timeline_says_who_closed_it(
        self, client, admin_headers, incident
    ):
        response = await client.post(
            f"/api/incidents/{incident.id}/resolve",
            json={"note": "Decommissioned."},
            headers=admin_headers,
        )

        entries = response.json()["timeline"] or []
        assert entries
        last = entries[-1]
        assert last["kind"] == "resolved_by_hand"
        assert "admin" in last["detail"] and "Decommissioned." in last["detail"]

    async def test_resolving_twice_conflicts(
        self, client, admin_headers, incident
    ):
        """The second caller acted on a state the incident is no longer in -
        usually because the worker saw a recovery while the dialog was open."""
        await client.post(
            f"/api/incidents/{incident.id}/resolve",
            json={"note": "First."},
            headers=admin_headers,
        )
        response = await client.post(
            f"/api/incidents/{incident.id}/resolve",
            json={"note": "Second."},
            headers=admin_headers,
        )

        assert response.status_code == 409

    async def test_a_reason_is_required(self, client, admin_headers, incident):
        """A resolved incident with no reason on it is the outcome this
        feature would otherwise be used to produce."""
        response = await client.post(
            f"/api/incidents/{incident.id}/resolve",
            json={"note": "  "},
            headers=admin_headers,
        )

        assert response.status_code == 422

    async def test_a_viewer_cannot_resolve(self, client, viewer_headers, incident):
        """incident:write is admin-only, which is what makes this an admin
        action rather than anyone's."""
        response = await client.post(
            f"/api/incidents/{incident.id}/resolve",
            json={"note": "Not mine to close."},
            headers=viewer_headers,
        )

        assert response.status_code == 403

    async def test_an_unknown_incident_is_404(self, client, admin_headers, seeded):
        response = await client.post(
            "/api/incidents/999999/resolve",
            json={"note": "Nothing here."},
            headers=admin_headers,
        )

        assert response.status_code == 404
