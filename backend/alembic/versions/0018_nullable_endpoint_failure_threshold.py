"""Let an endpoint inherit its failure threshold.

0011 added the middle tier - an environment can set a failure threshold that
its endpoints inherit - and monitoring_service.resolve_thresholds implements
the order: endpoint override -> environment override -> global setting.

For three of the four thresholds that worked. `endpoints.failure_threshold`
was NOT NULL with a default of 3, and endpoint creation resolved the global
setting and wrote the result onto the row, so every endpoint carried a
concrete value. Resolution therefore always stopped at the first tier, and an
environment-level or global failure threshold could never apply to anything.

This drops the NOT NULL so the column can mean "inherit", matching the three
siblings that already do (response_time_threshold_ms, ssl_warning_days,
ssl_critical_days).

Existing rows are deliberately left alone. Every endpoint keeps the explicit
value it already has, so no deployment's alerting changes underneath it on
upgrade. Clearing the field on an endpoint is how an operator opts it in to
the environment or global value from here on.

Revision ID: 0018
Revises: 0017
Created: 2026-09-17
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # SQLite cannot ALTER a column in place; batch_alter_table rebuilds the
    # table there and emits a plain ALTER on PostgreSQL.
    with op.batch_alter_table("endpoints") as batch:
        batch.alter_column(
            "failure_threshold",
            existing_type=sa.Integer(),
            nullable=True,
            existing_nullable=False,
            server_default=None,
        )


def downgrade() -> None:
    # NULL means inherit, and the pre-0018 schema cannot express that. Fill
    # them with the default the column used to carry before restoring NOT
    # NULL, or the constraint cannot be applied.
    op.execute(
        "UPDATE endpoints SET failure_threshold = 3 WHERE failure_threshold IS NULL"
    )
    with op.batch_alter_table("endpoints") as batch:
        batch.alter_column(
            "failure_threshold",
            existing_type=sa.Integer(),
            nullable=False,
            existing_nullable=True,
        )
