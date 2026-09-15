"""The last successful and last failed response.

The requirement these exist to hold is storage, not display: two rows per
endpoint no matter how many times it is checked, with each new capture
replacing the one it supersedes. Everything else here is secondary to that.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.core.enums import CaptureOutcome, CheckStatus, FailureReason
from app.models.monitoring import EndpointCapture
from app.monitoring.checker import CheckOutcome
from app.services import capture_service


def outcome(
    *,
    up: bool = True,
    body: bytes | None = b"OK",
    content_type: str = "text/plain",
    status_code: int = 200,
    at: datetime | None = None,
    total_bytes: int | None = None,
) -> CheckOutcome:
    result = CheckOutcome()
    result.status = CheckStatus.UP.value if up else CheckStatus.DOWN.value
    result.checked_at = at or datetime.now(timezone.utc)
    result.http_status_code = status_code
    result.response_headers = {"content-type": content_type}
    result.body_head = body
    result.content_length = total_bytes if total_bytes is not None else len(body or b"")
    result.response_time_ms = 42.0
    if not up:
        result.failure_reason = FailureReason.CONNECTION_TIMEOUT.value
        result.error_message = "Connection timeout"
    return result


async def count_rows(session) -> int:
    return (
        await session.execute(select(func.count()).select_from(EndpointCapture))
    ).scalar() or 0


class TestStoragePolicy:
    """Two rows per endpoint, ever. This is the whole point of the feature."""

    async def test_repeated_checks_never_add_rows(self, session, endpoint_factory):
        endpoint = await endpoint_factory()

        for index in range(25):
            await capture_service.record_check(
                session,
                endpoint.id,
                outcome(up=index % 2 == 0, body=f"body {index}".encode()),
            )
        await session.commit()

        # Twenty-five checks, thirteen of them passing. Two rows.
        assert await count_rows(session) == 2

    async def test_a_new_capture_replaces_the_old_one(self, session, endpoint_factory):
        endpoint = await endpoint_factory()

        await capture_service.record_check(
            session, endpoint.id, outcome(body=b"the first response")
        )
        await session.commit()

        await capture_service.record_check(
            session, endpoint.id, outcome(body=b"the second response")
        )
        await session.commit()

        rows = await capture_service.list_for_endpoint(session, endpoint.id)
        assert len(rows) == 1
        assert rows[0].body == "the second response"

    async def test_success_and_failure_are_kept_separately(
        self, session, endpoint_factory
    ):
        endpoint = await endpoint_factory()

        await capture_service.record_check(
            session, endpoint.id, outcome(up=True, body=b"healthy")
        )
        await capture_service.record_check(
            session, endpoint.id, outcome(up=False, body=b"502 Bad Gateway")
        )
        await session.commit()

        rows = {
            row.outcome: row
            for row in await capture_service.list_for_endpoint(session, endpoint.id)
        }
        assert set(rows) == {"success", "failure"}
        assert rows["success"].body == "healthy"
        # The point of the feature: the failing response survives the recovery
        # that follows it.
        assert rows["failure"].body == "502 Bad Gateway"

    async def test_a_recovery_does_not_erase_the_last_failure(
        self, session, endpoint_factory
    ):
        endpoint = await endpoint_factory()

        await capture_service.record_check(
            session, endpoint.id, outcome(up=False, body=b"connection refused")
        )
        await session.commit()

        for _ in range(5):
            await capture_service.record_check(
                session, endpoint.id, outcome(up=True, body=b"healthy")
            )
        await session.commit()

        failure = await capture_service.get(
            session, endpoint.id, CaptureOutcome.FAILURE.value
        )
        assert failure is not None
        assert failure.body == "connection refused"

    async def test_captures_belong_to_their_endpoint(
        self, session, endpoint_factory
    ):
        """Two endpoints, two pairs - not four rows in one bucket.

        Deletion is not asserted here: the cascade is a database constraint,
        and this suite runs on SQLite, which does not enforce one without
        PRAGMA foreign_keys. It is declared on the column and on the
        relationship, and Postgres applies it.
        """
        first = await endpoint_factory()
        second = await endpoint_factory()

        await capture_service.record_check(session, first.id, outcome(body=b"first"))
        await capture_service.record_check(session, second.id, outcome(body=b"second"))
        await session.commit()

        assert await count_rows(session) == 2
        mine = await capture_service.list_for_endpoint(session, first.id)
        assert len(mine) == 1 and mine[0].body == "first"


class TestBody:
    def test_degraded_counts_as_a_success(self):
        """The endpoint answered. What it answered with is what this is for."""
        slow = CheckOutcome()
        slow.status = CheckStatus.DEGRADED.value
        assert capture_service.outcome_for(slow) == CaptureOutcome.SUCCESS.value

    @pytest.mark.parametrize(
        "content_type",
        ["image/png", "application/octet-stream", "application/pdf"],
    )
    def test_binary_responses_are_not_stored_as_text(self, content_type):
        assert capture_service.decode_body(b"\x89PNG\r\n", content_type) is None

    def test_a_missing_content_type_is_treated_as_text(self):
        """Proxy error pages routinely omit it, and those are the responses
        this feature exists to keep."""
        assert capture_service.decode_body(b"502 Bad Gateway", None) == "502 Bad Gateway"

    def test_binary_with_a_text_content_type_is_still_rejected(self):
        """A NUL byte settles it regardless of what the header claimed."""
        assert capture_service.decode_body(b"PK\x03\x04\x00\x00", "text/plain") is None

    def test_undecodable_bytes_do_not_lose_the_response(self):
        """An error page mislabelled as UTF-8 is still the page someone needs."""
        body = capture_service.decode_body(b"caf\xe9 down", "text/html")
        assert body is not None and "down" in body

    def test_a_stray_nul_is_stripped_not_rejected(self):
        """PostgreSQL cannot store a NUL in a text column at all, and this row
        is written in the same transaction as the check result - so one stray
        byte would roll back a good check, and keep rolling it back on every
        future check of that endpoint."""
        body = capture_service.decode_body(
            b"<html>ok</html>" + b"\x00" + b"trailing", "text/html"
        )
        assert body is not None
        assert "\x00" not in body
        assert "trailing" in body

    def test_the_body_is_capped(self):
        body = capture_service.decode_body(b"x" * 100_000, "text/plain")
        assert len(body) == capture_service.MAX_BODY_CHARS

    async def test_truncation_records_the_full_size(self, session, endpoint_factory):
        """The panel says "the first 16 KB of 2.1 MB" rather than implying the
        response was small."""
        endpoint = await endpoint_factory()
        await capture_service.record_check(
            session,
            endpoint.id,
            outcome(body=b"y" * 64_000, total_bytes=2_100_000),
        )
        await session.commit()

        row = await capture_service.get(
            session, endpoint.id, CaptureOutcome.SUCCESS.value
        )
        assert row.body_truncated is True
        assert row.body_bytes == 2_100_000


class TestScreenshot:
    async def test_it_attaches_to_the_matching_capture(
        self, session, endpoint_factory
    ):
        endpoint = await endpoint_factory()
        await capture_service.record_check(session, endpoint.id, outcome())
        await session.commit()

        attached = await capture_service.attach_screenshot(
            session,
            endpoint.id,
            CaptureOutcome.SUCCESS.value,
            image=b"\xff\xd8\xffJPEG",
            width=1280,
            height=800,
        )
        await session.commit()

        assert attached is True
        row = await capture_service.get(
            session, endpoint.id, CaptureOutcome.SUCCESS.value
        )
        await session.refresh(row, ["image"])
        assert row.image == b"\xff\xd8\xffJPEG"
        assert row.image_etag and row.image_bytes == 7

    async def test_a_new_response_clears_the_old_screenshot(
        self, session, endpoint_factory
    ):
        """A picture of the previous response beside the current body would be
        worse than no picture at all."""
        endpoint = await endpoint_factory()
        await capture_service.record_check(session, endpoint.id, outcome())
        await capture_service.attach_screenshot(
            session, endpoint.id, CaptureOutcome.SUCCESS.value, image=b"old"
        )
        await session.commit()

        await capture_service.record_check(
            session, endpoint.id, outcome(body=b"a newer response")
        )
        await session.commit()

        row = await capture_service.get(
            session, endpoint.id, CaptureOutcome.SUCCESS.value
        )
        await session.refresh(row, ["image"])
        assert row.image is None
        assert row.image_etag is None

    async def test_a_render_that_finishes_late_is_dropped(
        self, session, endpoint_factory
    ):
        """Rendering runs outside the check's transaction, so by the time the
        image lands the row may already describe a different response. Writing
        it anyway would pair a picture of one response with the record of
        another."""
        endpoint = await endpoint_factory()
        started = datetime.now(timezone.utc) - timedelta(seconds=30)

        # The check this render belongs to, then a newer one that replaced it.
        await capture_service.record_check(session, endpoint.id, outcome(at=started))
        await capture_service.record_check(session, endpoint.id, outcome())
        await session.commit()

        attached = await capture_service.attach_screenshot(
            session,
            endpoint.id,
            CaptureOutcome.SUCCESS.value,
            image=b"stale",
            captured_at=started,
        )
        assert attached is False

    async def test_a_failed_render_records_why(self, session, endpoint_factory):
        """An empty box reads as the feature being broken rather than the page
        being unrenderable."""
        endpoint = await endpoint_factory()
        await capture_service.record_check(session, endpoint.id, outcome())
        await session.commit()

        await capture_service.attach_screenshot(
            session,
            endpoint.id,
            CaptureOutcome.SUCCESS.value,
            image=None,
            error="Timeout 20000ms exceeded.",
        )
        await session.commit()

        row = await capture_service.get(
            session, endpoint.id, CaptureOutcome.SUCCESS.value
        )
        assert row.image_error == "Timeout 20000ms exceeded."

    async def test_an_image_for_a_missing_capture_is_dropped(
        self, session, endpoint_factory
    ):
        endpoint = await endpoint_factory()
        attached = await capture_service.attach_screenshot(
            session, endpoint.id, CaptureOutcome.FAILURE.value, image=b"orphan"
        )
        assert attached is False


class TestApi:
    async def test_captures_are_listed_newest_first(
        self, client, admin_headers, session, endpoint_factory
    ):
        endpoint = await endpoint_factory()
        await capture_service.record_check(
            session,
            endpoint.id,
            outcome(up=False, at=datetime.now(timezone.utc) - timedelta(minutes=5)),
        )
        await capture_service.record_check(session, endpoint.id, outcome(up=True))
        await session.commit()

        response = await client.get(
            f"/api/endpoints/{endpoint.id}/captures", headers=admin_headers
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert [row["outcome"] for row in body] == ["success", "failure"]
        # The image bytes are never inlined - the panel fetches them from the
        # image route so the browser can cache them.
        assert "image" not in body[0]
        assert body[0]["has_image"] is False

    async def test_the_image_route_404s_without_one(
        self, client, admin_headers, session, endpoint_factory
    ):
        endpoint = await endpoint_factory()
        await capture_service.record_check(session, endpoint.id, outcome())
        await session.commit()

        response = await client.get(
            f"/api/endpoints/{endpoint.id}/captures/success/image",
            headers=admin_headers,
        )
        assert response.status_code == 404

    async def test_the_image_route_serves_and_revalidates(
        self, client, admin_headers, session, endpoint_factory
    ):
        endpoint = await endpoint_factory()
        await capture_service.record_check(session, endpoint.id, outcome())
        await capture_service.attach_screenshot(
            session,
            endpoint.id,
            CaptureOutcome.SUCCESS.value,
            image=b"\xff\xd8\xffJPEGBYTES",
        )
        await session.commit()

        response = await client.get(
            f"/api/endpoints/{endpoint.id}/captures/success/image",
            headers=admin_headers,
        )
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("image/jpeg")
        etag = response.headers["etag"]
        assert etag

        # A browser that already has it is told so, and the bytes stay in the
        # database.
        again = await client.get(
            f"/api/endpoints/{endpoint.id}/captures/success/image",
            headers={**admin_headers, "If-None-Match": etag},
        )
        assert again.status_code == 304
        assert not again.content

    async def test_an_unknown_outcome_is_rejected(
        self, client, admin_headers, endpoint_factory
    ):
        endpoint = await endpoint_factory()
        response = await client.get(
            f"/api/endpoints/{endpoint.id}/captures/maybe/image", headers=admin_headers
        )
        assert response.status_code == 404


class TestOptIn:
    async def test_screenshots_are_off_by_default(self, client, admin_headers):
        response = await client.post(
            "/api/endpoints",
            json={"name": "Capture default", "url": "https://cap.example.com/health"},
            headers=admin_headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["screenshot_enabled"] is False

    async def test_a_tcp_check_cannot_opt_in(self, client, admin_headers):
        """There is no page to render for a TCP handshake, so the flag is
        refused rather than stored and silently ignored."""
        response = await client.post(
            "/api/endpoints",
            json={
                "name": "Capture tcp",
                "url": "https://cap-tcp.example.com:5432",
                "check_type": "tcp",
                "screenshot_enabled": True,
            },
            headers=admin_headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["screenshot_enabled"] is False

    async def test_an_http_check_can_opt_in(self, client, admin_headers):
        response = await client.post(
            "/api/endpoints",
            json={
                "name": "Capture http",
                "url": "https://cap-http.example.com/status",
                "screenshot_enabled": True,
            },
            headers=admin_headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["screenshot_enabled"] is True
