"""Where else the endpoint was checked from, when it was about to be declared down.

A single VM has one egress path, so a local failure and a real outage look
identical. A vantage point is a proxy the worker can reach - a Tor SocksPort, a
VPN container exposing SOCKS - that lets the same check leave by a different
route.

Only the latest confirmation has ever been worth reading, and it is only
produced on the check that would otherwise have opened an incident, so it lives
on the endpoint rather than in a table of its own. The vantage points
themselves are environment configuration (VANTAGE_POINTS), not rows: they carry
proxy URLs that may hold credentials.

Revision ID: 0016
Revises: 0015
Created: 2026-09-15
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("endpoints", sa.Column("last_vantage_check", sa.JSON(), nullable=True))
    op.add_column(
        "endpoints",
        sa.Column("last_vantage_check_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("endpoints", "last_vantage_check_at")
    op.drop_column("endpoints", "last_vantage_check")
