"""What the endpoint returned, the last time it passed and the last time it failed.

Two rows per endpoint, ever, enforced by the primary key ``(endpoint_id,
outcome)`` rather than by a sweep somebody has to remember to run. Writing a
capture REPLACES the one it supersedes, so this table's size is a function of
how many endpoints exist and not of how often they are checked - which is the
whole point, next to ``monitoring_results``, which grows with check volume and
is pruned by retention.

The body is captured for every endpoint and costs a few kilobytes. The
screenshot is opt-in per endpoint (``endpoints.screenshot_enabled``, added
here, default false) because rendering a page costs a browser page and most
monitored endpoints are JSON health routes.

Revision ID: 0015
Revises: 0014
Created: 2026-09-15
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "endpoints",
        sa.Column(
            "screenshot_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    op.create_table(
        "endpoint_captures",
        sa.Column("endpoint_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("outcome", sa.String(length=8), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("captured_by", sa.String(length=64), nullable=True),
        # the check that produced it
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("http_status_code", sa.Integer(), nullable=True),
        sa.Column("failure_reason", sa.String(length=32), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("response_time_ms", sa.Float(), nullable=True),
        sa.Column("final_url", sa.String(length=2048), nullable=True),
        # the body
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("content_type", sa.String(length=128), nullable=True),
        sa.Column("body_bytes", sa.Integer(), nullable=True),
        sa.Column(
            "body_truncated", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("response_headers", sa.JSON(), nullable=True),
        # the screenshot
        sa.Column("image", sa.LargeBinary(), nullable=True),
        sa.Column("image_type", sa.String(length=32), nullable=True),
        sa.Column("image_bytes", sa.Integer(), nullable=True),
        sa.Column("image_width", sa.Integer(), nullable=True),
        sa.Column("image_height", sa.Integer(), nullable=True),
        sa.Column("image_etag", sa.String(length=64), nullable=True),
        sa.Column("image_error", sa.String(length=255), nullable=True),
        sa.Column("image_captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["endpoint_id"], ["endpoints.id"], ondelete="CASCADE"
        ),
        # The cap. Not an index, not a policy - the shape of the table.
        sa.PrimaryKeyConstraint("endpoint_id", "outcome"),
        sa.CheckConstraint(
            "outcome IN ('success', 'failure')",
            name="ck_endpoint_captures_outcome",
        ),
    )
    op.create_index(
        "ix_endpoint_captures_captured_at", "endpoint_captures", ["captured_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_endpoint_captures_captured_at", table_name="endpoint_captures")
    op.drop_table("endpoint_captures")
    op.drop_column("endpoints", "screenshot_enabled")
