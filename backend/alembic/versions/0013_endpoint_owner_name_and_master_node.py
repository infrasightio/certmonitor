"""Owner's name, and the node the service runs on.

``owner`` holds whatever people type to reach someone, which in practice is
an email address - so every screen showing an owner shows an address rather
than a person. ``owner_name`` carries the person; the address stays, because
it is how you contact them.

``master_node_ip`` records where the service actually runs, so the operator
reading a failing endpoint does not have to go and look it up elsewhere.
Free text, not a validated address: clusters are named inconsistently across
a fleet, and rejecting "10.0.1.4 (prod-master-1)" would only push it into
the description.

Revision ID: 0013
Revises: 0012
Created: 2026-09-14
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("endpoints", sa.Column("owner_name", sa.String(length=128), nullable=True))
    op.add_column(
        "endpoints", sa.Column("master_node_ip", sa.String(length=128), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("endpoints", "master_node_ip")
    op.drop_column("endpoints", "owner_name")
