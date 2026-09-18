"""Record who resolved an incident by hand, and why.

Until now the worker was the only thing that could close an incident: it
opened one on the threshold-th consecutive failure and resolved it on
recovery. That leaves no way to close an incident the worker will never
recover from - an endpoint paused while down, one whose outage was handled
outside the monitor, or a run of noise somebody wants off the open list.

Two columns, mirroring the acknowledgement pair that already sits beside
them. `resolved_by_id` is what distinguishes a resolution by hand from one
the worker made on observed recovery: it is NULL for every incident the
worker closed, including all existing rows, so no history is reinterpreted by
this upgrade. `resolution_note` is why, and it is required by the API rather
than by the column - an incident closed with no explanation is the thing this
feature would otherwise be used for.

Revision ID: 0019
Revises: 0018
Created: 2026-09-18
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID = sa.Uuid(as_uuid=True)


def upgrade() -> None:
    # Batch mode so SQLite gets a table rebuild and PostgreSQL a plain ALTER.
    # The FK is named explicitly: SQLite cannot drop an unnamed constraint, so
    # an anonymous one here would make the downgrade unrunnable.
    with op.batch_alter_table("incidents") as batch:
        batch.add_column(sa.Column("resolved_by_id", UUID, nullable=True))
        batch.add_column(sa.Column("resolution_note", sa.Text(), nullable=True))
        batch.create_foreign_key(
            "fk_incidents_resolved_by_id_users",
            "users",
            ["resolved_by_id"],
            ["id"],
            # The record of the resolution outlives the account that made it.
            # Deleting a user must not delete their incident history.
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("incidents") as batch:
        batch.drop_constraint("fk_incidents_resolved_by_id_users", type_="foreignkey")
        batch.drop_column("resolution_note")
        batch.drop_column("resolved_by_id")
