"""The last successful and last failed capture of an endpoint.

Two rows per endpoint, ever. Nothing here sweeps or prunes: the primary key is
``(endpoint_id, outcome)``, so a new capture overwrites the one it supersedes
and the table's size is a function of how many endpoints exist rather than of
how often they are checked. That is the difference between this table and
``monitoring_results``, which grows with check volume and is pruned by
retention.

Every capture carries the response body, truncated and only when it is text.
The screenshot is optional, arrives separately (rendering takes seconds and
must never sit inside a check's transaction), and is merged into whichever row
is current at the time.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import CaptureOutcome
from app.core.logging import get_logger
from app.models.monitoring import EndpointCapture
from app.monitoring.checker import CheckOutcome

logger = get_logger(__name__)

# Well under the 64 KB the probe keeps: this is what lands in a Text column and
# is sent to a browser on every detail page load. Enough to hold a stack trace
# or an error page, not enough for a minified bundle to matter.
MAX_BODY_CHARS = 16_000

# Content types worth keeping as text. Everything else - images, PDFs,
# protobuf, gzip - would be stored as mojibake and shown as noise, so it is not
# stored at all; the metadata row still records what the type was.
_TEXT_TYPES = (
    "text/",
    "application/json",
    "application/xml",
    "application/xhtml",
    "application/javascript",
    "application/problem+json",
    "application/ld+json",
    "application/graphql",
    "application/x-www-form-urlencoded",
)


def outcome_for(check: CheckOutcome) -> str:
    """Which of the two rows this check belongs in.

    Degraded counts as a success: the endpoint answered, and what it answered
    with is what the capture is for.
    """
    return (
        CaptureOutcome.SUCCESS.value if check.is_up else CaptureOutcome.FAILURE.value
    )


def _is_text(content_type: str | None) -> bool:
    if not content_type:
        # No type header at all. Common on error pages from proxies, and those
        # are exactly the responses worth keeping, so assume text and let the
        # decode below decide.
        return True
    lowered = content_type.split(";", 1)[0].strip().lower()
    return lowered.startswith(_TEXT_TYPES)


# A NUL this early is a magic number, not a typo: ZIP and JPEG put one at
# byte 4, GIF at 6, PNG at 8. The bound stays under the length of the
# shortest plausible HTML document, so a stray NUL in real markup is not
# mistaken for a file header.
_BINARY_PREFIX_CHARS = 12
# Past this share of a sample large enough to judge, it is binary whatever the
# first bytes looked like. Short bodies are exempt: one NUL in twenty
# characters is a high proportion and tells you nothing.
_MAX_NUL_SHARE = 0.02
_NUL_SAMPLE_MIN = 256


def _looks_binary(text: str) -> bool:
    """Whether a body claiming to be text is really a mislabelled file.

    Position first, then density. Testing only "is there a NUL in the first
    kilobyte" cannot tell a ZIP header from one stray byte in an error page,
    and rejecting the page loses exactly the response captures exist to keep.
    """
    if "\x00" in text[:_BINARY_PREFIX_CHARS]:
        return True
    sample = text[:1024]
    if len(sample) < _NUL_SAMPLE_MIN:
        return False
    return sample.count("\x00") / len(sample) > _MAX_NUL_SHARE


def decode_body(raw: bytes | None, content_type: str | None) -> str | None:
    """Turn the probe's raw bytes into something worth showing, or None.

    Decoded leniently: an error page served as latin-1 while claiming UTF-8 is
    still the page someone needs to read, and refusing it over an encoding
    quibble would lose exactly the response this feature exists for.

    NUL bytes are removed rather than tolerated. PostgreSQL cannot store one in
    a `text` column at all, and this row is written in the same transaction as
    the check result - so a single stray NUL in a response body would roll back
    a perfectly good check, and keep rolling it back on every future check of
    that endpoint. Leading NULs mean the response was binary whatever the
    header claimed, and that is still rejected outright.
    """
    if not raw or not _is_text(content_type):
        return None
    text = raw.decode("utf-8", errors="replace")
    # Binary mislabelled as text. Checked before the strip below, because a
    # stripped JPEG is not a document, it is noise.
    if _looks_binary(text):
        return None
    text = text[:MAX_BODY_CHARS]
    return text.replace("\x00", "") if "\x00" in text else text


async def get(
    session: AsyncSession, endpoint_id: uuid.UUID, outcome: str
) -> EndpointCapture | None:
    return (
        await session.execute(
            select(EndpointCapture).where(
                EndpointCapture.endpoint_id == endpoint_id,
                EndpointCapture.outcome == outcome,
            )
        )
    ).scalar_one_or_none()


async def list_for_endpoint(
    session: AsyncSession, endpoint_id: uuid.UUID
) -> list[EndpointCapture]:
    """Both captures, newest first. At most two rows by construction."""
    rows = (
        await session.execute(
            select(EndpointCapture)
            .where(EndpointCapture.endpoint_id == endpoint_id)
            .order_by(EndpointCapture.captured_at.desc())
        )
    ).scalars().all()
    return list(rows)


async def record_check(
    session: AsyncSession,
    endpoint_id: uuid.UUID,
    check: CheckOutcome,
    *,
    captured_by: str | None = None,
) -> EndpointCapture:
    """Replace this endpoint's capture for whichever outcome the check had.

    The row is upserted rather than appended, which is the entire storage
    policy. Any screenshot already on the row is CLEARED: it belonged to the
    previous response, and showing an old picture beside a new body would be
    worse than showing no picture at all.
    """
    outcome = outcome_for(check)
    row = await get(session, endpoint_id, outcome)
    if row is None:
        row = EndpointCapture(endpoint_id=endpoint_id, outcome=outcome)
        session.add(row)

    content_type = (check.response_headers or {}).get("content-type")
    body = decode_body(check.body_head, content_type)

    row.captured_at = check.checked_at or datetime.now(timezone.utc)
    row.captured_by = (captured_by or "")[:64] or None
    row.status = check.status
    row.http_status_code = check.http_status_code
    row.failure_reason = check.failure_reason
    row.error_message = (check.error_message or None) and check.error_message[:2000]
    row.response_time_ms = check.response_time_ms
    row.final_url = (check.final_url or None) and check.final_url[:2048]

    row.body = body
    row.content_type = (content_type or None) and content_type[:128]
    row.body_bytes = check.content_length
    row.body_truncated = bool(
        check.body_truncated or (body is not None and len(body) >= MAX_BODY_CHARS)
    )
    row.response_headers = check.response_headers or None

    # The screenshot for this response has not been taken yet, and the one
    # sitting here is of the previous one.
    row.image = None
    row.image_type = None
    row.image_bytes = None
    row.image_width = None
    row.image_height = None
    row.image_etag = None
    row.image_error = None
    row.image_captured_at = None

    await session.flush()
    return row


async def attach_screenshot(
    session: AsyncSession,
    endpoint_id: uuid.UUID,
    outcome: str,
    *,
    image: bytes | None,
    content_type: str = "image/jpeg",
    width: int | None = None,
    height: int | None = None,
    error: str | None = None,
    captured_at: datetime | None = None,
) -> bool:
    """Merge a rendered screenshot into an existing capture row.

    Returns False when the row is gone or has already moved on. Rendering takes
    seconds and runs outside the check's transaction, so by the time the image
    arrives the endpoint may have been deleted, or checked again and flipped to
    the other outcome. Writing the image onto whatever row happens to be there
    would attach a picture of one response to the record of another, so it is
    dropped instead.
    """
    row = await get(session, endpoint_id, outcome)
    if row is None:
        return False

    captured_at = captured_at or datetime.now(timezone.utc)
    # The body was written first; a row that has been replaced since has a
    # LATER captured_at than the check this render belongs to.
    if row.captured_at and captured_at < row.captured_at:
        logger.debug(
            "screenshot_dropped_stale",
            endpoint_id=str(endpoint_id),
            outcome=outcome,
        )
        return False

    if image:
        row.image = image
        row.image_type = content_type
        row.image_bytes = len(image)
        row.image_width = width
        row.image_height = height
        row.image_etag = hashlib.sha256(image).hexdigest()[:32]
        row.image_error = None
    else:
        row.image = None
        row.image_etag = None
        row.image_error = (error or "The page could not be rendered.")[:255]

    row.image_captured_at = captured_at
    await session.flush()
    return True


def to_dict(row: EndpointCapture) -> dict[str, Any]:
    """Capture metadata and body, without the image bytes.

    The image is served by its own route so it can be cached by ETag; dragging
    a hundred kilobytes of JPEG through a JSON payload on every page load would
    defeat that.
    """
    return {
        "outcome": row.outcome,
        "captured_at": row.captured_at,
        "captured_by": row.captured_by,
        "status": row.status,
        "http_status_code": row.http_status_code,
        "failure_reason": row.failure_reason,
        "error_message": row.error_message,
        "response_time_ms": row.response_time_ms,
        "final_url": row.final_url,
        "body": row.body,
        "content_type": row.content_type,
        "body_bytes": row.body_bytes,
        "body_truncated": row.body_truncated,
        "response_headers": row.response_headers,
        "has_image": bool(row.image_etag),
        "image_type": row.image_type,
        "image_bytes": row.image_bytes,
        "image_width": row.image_width,
        "image_height": row.image_height,
        "image_error": row.image_error,
        "image_captured_at": row.image_captured_at,
    }
