"""Where a worker runs, and where a vantage point actually comes out.

``worker_heartbeats.region`` is a label its operator sets. Purely descriptive - nothing
schedules by it - but on a fleet spread across availability zones it is the
difference between "three workers" and knowing which one is where.

``vantage_status`` records the observed exit of each configured vantage. The
name in VANTAGE_POINTS is something somebody typed; Tor runs with StrictNodes 0
so it falls back to another country rather than failing, which means a vantage
labelled "Germany" can quietly answer from elsewhere. One row per vantage,
refreshed by the worker and read by the API, because they are separate
processes and an in-memory cache would be invisible to the screen that needs
it.

Revision ID: 0017
Revises: 0016
Created: 2026-09-15
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "worker_heartbeats", sa.Column("region", sa.String(length=64), nullable=True)
    )

    op.create_table(
        "vantage_status",
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("proxy", sa.String(length=255), nullable=True),
        sa.Column("observed_ip", sa.String(length=64), nullable=True),
        sa.Column("observed_country", sa.String(length=8), nullable=True),
        sa.Column("observed_city", sa.String(length=64), nullable=True),
        sa.Column("reachable", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("error", sa.String(length=255), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("observed_by", sa.String(length=64), nullable=True),
        sa.PrimaryKeyConstraint("name"),
    )


def downgrade() -> None:
    op.drop_table("vantage_status")
    op.drop_column("worker_heartbeats", "region")
