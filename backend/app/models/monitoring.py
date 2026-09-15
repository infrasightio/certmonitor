"""Monitoring results and SSL certificate observations."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import FailureReason, SslStatus
from app.models.base import Base, BigIntType, JSONType, TimestampTZ, utcnow


class MonitoringResult(Base):
    """One row per executed check.

    This is the highest-volume table in the system, so it uses a bigint key, no
    ORM relationships loaded by default, and is pruned by the retention sweep.
    """

    __tablename__ = "monitoring_results"
    __table_args__ = (
        Index("ix_monitoring_results_endpoint_time", "endpoint_id", "checked_at"),
        Index("ix_monitoring_results_checked_at", "checked_at"),
        Index("ix_monitoring_results_endpoint_status", "endpoint_id", "status"),
    )

    id: Mapped[int] = mapped_column(BigIntType, primary_key=True, autoincrement=True)
    endpoint_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("endpoints.id", ondelete="CASCADE"),
        nullable=False,
    )
    endpoint: Mapped["Endpoint"] = relationship(  # noqa: F821
        back_populates="results", lazy="noload"
    )

    checked_at: Mapped[datetime] = mapped_column(
        TimestampTZ, nullable=False, default=utcnow, server_default=func.now()
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    http_status_code: Mapped[int | None] = mapped_column(Integer)

    # All timings in milliseconds. Sub-timings are best-effort: a plain TCP
    # check has no TLS phase, a cached DNS lookup reports ~0.
    response_time_ms: Mapped[float | None] = mapped_column(Float)
    dns_time_ms: Mapped[float | None] = mapped_column(Float)
    connect_time_ms: Mapped[float | None] = mapped_column(Float)
    tls_time_ms: Mapped[float | None] = mapped_column(Float)
    ttfb_ms: Mapped[float | None] = mapped_column(Float)
    total_time_ms: Mapped[float | None] = mapped_column(Float)

    resolved_ip: Mapped[str | None] = mapped_column(String(64))
    content_length: Mapped[int | None] = mapped_column(Integer)
    redirect_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    final_url: Mapped[str | None] = mapped_column(String(2048))
    redirect_chain: Mapped[list | None] = mapped_column(JSONType)

    # Response headers are kept (they are operationally useful) but bodies are
    # never stored - see monitoring/checker.py.
    response_headers: Mapped[dict | None] = mapped_column(JSONType)

    error_message: Mapped[str | None] = mapped_column(Text)
    failure_reason: Mapped[str] = mapped_column(
        String(32), nullable=False, default=FailureReason.NONE.value
    )

    tls_version: Mapped[str | None] = mapped_column(String(24))
    tls_cipher: Mapped[str | None] = mapped_column(String(96))
    cert_expires_at: Mapped[datetime | None] = mapped_column(TimestampTZ)
    ssl_days_remaining: Mapped[int | None] = mapped_column(Integer)
    ssl_status: Mapped[str | None] = mapped_column(String(24))

    checked_by: Mapped[str | None] = mapped_column(String(64))
    is_manual: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # How many retries it took to reach this result. 0 (the default, and the
    # only possible value while check_retry_attempts is off) means the first
    # attempt already produced it. Kept so a success-after-retry stays visible
    # to intermittent-failure detection instead of reading like a clean pass.
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class SslCertificate(Base):
    """A certificate observation.

    A new row is written whenever the observed fingerprint changes (renewals,
    rotations), giving a certificate history per endpoint. ``is_current``
    marks the latest observation.
    """

    __tablename__ = "ssl_certificates"
    __table_args__ = (
        Index("ix_ssl_certificates_endpoint_current", "endpoint_id", "is_current"),
        Index("ix_ssl_certificates_valid_to", "valid_to"),
        Index("ix_ssl_certificates_status", "status"),
    )

    id: Mapped[int] = mapped_column(BigIntType, primary_key=True, autoincrement=True)
    endpoint_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("endpoints.id", ondelete="CASCADE"),
        nullable=False,
    )
    endpoint: Mapped["Endpoint"] = relationship(  # noqa: F821
        back_populates="certificates", lazy="noload"
    )

    fingerprint_sha256: Mapped[str | None] = mapped_column(String(95), index=True)
    serial_number: Mapped[str | None] = mapped_column(String(128))

    subject: Mapped[str | None] = mapped_column(String(512))
    common_name: Mapped[str | None] = mapped_column(String(255), index=True)
    issuer: Mapped[str | None] = mapped_column(String(512))
    issuer_common_name: Mapped[str | None] = mapped_column(String(255), index=True)
    issuer_organization: Mapped[str | None] = mapped_column(String(255))
    san: Mapped[list | None] = mapped_column(JSONType)

    valid_from: Mapped[datetime | None] = mapped_column(TimestampTZ)
    valid_to: Mapped[datetime | None] = mapped_column(TimestampTZ)
    days_remaining: Mapped[int | None] = mapped_column(Integer)

    signature_algorithm: Mapped[str | None] = mapped_column(String(96))
    key_algorithm: Mapped[str | None] = mapped_column(String(48))
    key_size: Mapped[int | None] = mapped_column(Integer)
    version: Mapped[str | None] = mapped_column(String(16))

    tls_version: Mapped[str | None] = mapped_column(String(24))
    tls_cipher: Mapped[str | None] = mapped_column(String(96))

    is_self_signed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_wildcard: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    hostname_matches: Mapped[bool | None] = mapped_column(Boolean)
    chain_verified: Mapped[bool | None] = mapped_column(Boolean)
    verification_status: Mapped[str | None] = mapped_column(String(32))
    verification_error: Mapped[str | None] = mapped_column(Text)
    chain: Mapped[list | None] = mapped_column(JSONType)
    chain_length: Mapped[int | None] = mapped_column(Integer)

    status: Mapped[str] = mapped_column(
        String(24), nullable=False, default=SslStatus.UNABLE_TO_CHECK.value
    )
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    first_seen_at: Mapped[datetime] = mapped_column(
        TimestampTZ, nullable=False, default=utcnow, server_default=func.now()
    )
    checked_at: Mapped[datetime] = mapped_column(
        TimestampTZ, nullable=False, default=utcnow, server_default=func.now()
    )


class WorkerHeartbeat(Base):
    """Liveness record written by each monitoring worker.

    ``/health`` reads this to report on the worker without the API needing a
    direct channel to it.
    """

    __tablename__ = "worker_heartbeats"

    worker_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_seen_at: Mapped[datetime] = mapped_column(
        TimestampTZ, nullable=False, default=utcnow
    )
    started_at: Mapped[datetime] = mapped_column(
        TimestampTZ, nullable=False, default=utcnow
    )
    checks_completed: Mapped[int] = mapped_column(
        BigIntType, nullable=False, default=0
    )
    checks_failed: Mapped[int] = mapped_column(BigIntType, nullable=False, default=0)
    in_flight: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    version: Mapped[str | None] = mapped_column(String(32))
    hostname: Mapped[str | None] = mapped_column(String(128))

    # Self-reported cgroup figures. The worker measures its own container and
    # carries the numbers on the heartbeat it already writes, so the API can
    # report worker resource use without any channel to the worker process -
    # and without the Docker socket.
    cpu_percent: Mapped[float | None] = mapped_column(Float)
    memory_mb: Mapped[float | None] = mapped_column(Float)
    memory_limit_mb: Mapped[float | None] = mapped_column(Float)


class EndpointCapture(Base):
    """What the endpoint actually returned, the last time it passed and the
    last time it failed.

    Two rows per endpoint, ever. That is not a retention policy someone has to
    remember to run - it is the primary key: ``(endpoint_id, outcome)`` with
    ``outcome`` constrained to 'success' or 'failure', so writing a new capture
    REPLACES the old one and the table cannot grow with check volume the way
    ``monitoring_results`` does. Deleting the endpoint takes both rows with it.

    Every capture carries the response body, truncated. The screenshot is
    optional and opt-in per endpoint (``Endpoint.screenshot_enabled``), because
    rendering a page costs a browser and most monitored endpoints are JSON
    health routes where a picture of the text would tell you less than the
    text does.

    ``image`` is deferred: the detail panel reads the body and the metadata on
    every page load, and there is no reason to drag a hundred kilobytes of JPEG
    through that query when only the image route needs it.
    """

    __tablename__ = "endpoint_captures"
    __table_args__ = (
        CheckConstraint(
            "outcome IN ('success', 'failure')", name="ck_endpoint_captures_outcome"
        ),
        Index("ix_endpoint_captures_captured_at", "captured_at"),
    )

    endpoint_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("endpoints.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # 'success' or 'failure'. Degraded counts as a success: the endpoint
    # answered, and what it answered with is what this row is for.
    outcome: Mapped[str] = mapped_column(String(8), primary_key=True)

    captured_at: Mapped[datetime] = mapped_column(TimestampTZ, nullable=False)
    captured_by: Mapped[str | None] = mapped_column(String(64))

    # ------------------------------------------- the check that produced it
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    http_status_code: Mapped[int | None] = mapped_column(Integer)
    failure_reason: Mapped[str | None] = mapped_column(String(32))
    error_message: Mapped[str | None] = mapped_column(Text)
    response_time_ms: Mapped[float | None] = mapped_column(Float)
    final_url: Mapped[str | None] = mapped_column(String(2048))

    # ------------------------------------------------------------- the body
    # Text, not bytes: it is shown in a panel, searched by eye, and copied out
    # of the UI. Binary responses are not captured at all - see
    # capture_service.body_from_outcome.
    body: Mapped[str | None] = mapped_column(Text)
    content_type: Mapped[str | None] = mapped_column(String(128))
    # Length of the FULL response, not of what was kept, so the panel can say
    # "showing the first 64 KB of 2.1 MB" rather than implying the response was
    # small.
    body_bytes: Mapped[int | None] = mapped_column(Integer)
    body_truncated: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    response_headers: Mapped[dict | None] = mapped_column(JSONType)

    # ------------------------------------------------------ the screenshot
    image: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    image_type: Mapped[str | None] = mapped_column(String(32))
    image_bytes: Mapped[int | None] = mapped_column(Integer)
    image_width: Mapped[int | None] = mapped_column(Integer)
    image_height: Mapped[int | None] = mapped_column(Integer)
    # Cache validator for the image route, so a browser that already has this
    # screenshot is not sent it again until it is replaced.
    image_etag: Mapped[str | None] = mapped_column(String(64))
    # Why there is no image, when one was expected. A render that fails is
    # worth saying out loud - silently showing nothing looks like the feature
    # is broken rather than like the page is.
    image_error: Mapped[str | None] = mapped_column(String(255))
    image_captured_at: Mapped[datetime | None] = mapped_column(TimestampTZ)

    endpoint: Mapped["Endpoint"] = relationship(  # noqa: F821
        back_populates="captures"
    )
