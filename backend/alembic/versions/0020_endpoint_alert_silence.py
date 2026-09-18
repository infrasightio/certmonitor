"""Silence an endpoint's alerts without pausing its monitoring.

Pausing was the only way to stop an endpoint paging people, and it stops far
more than that: no checks run, so there are no results, no incidents and no
uptime figures for the period. For a deployment, a known issue being worked
on, or an endpoint that is simply noisy for an afternoon, that is the wrong
trade - the monitoring is exactly what you want to keep, it is only the
notifications you want to stop.

`alerts_enabled` on the endpoint already existed as a permanent per-endpoint
off switch, and it suppresses the alert ROW as well, so there is no record
that anything would have fired. These three columns are the temporary version,
and the difference is deliberate:

* `silenced_until` is required and bounded by the API, so a silence expires on
  its own. A silence that can be forgotten is how an outage goes unnoticed for
  a week, and no background job is needed to end one - it is compared against
  the clock wherever it is read.
* `silence_reason` is required by the API, for the same reason a pause needs
  one: silence on a dashboard has to be explainable weeks later.
* `silenced_by_id` is who, because "why is this quiet?" needs someone to ask.

Alerts are still raised and still recorded while a silence is in force - they
are marked `skipped` with the reason, so the history shows what would have
been sent. Checks, incidents and uptime are untouched.

Revision ID: 0020
Revises: 0019
Created: 2026-09-18
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID = sa.Uuid(as_uuid=True)


def upgrade() -> None:
    # Batch mode so SQLite rebuilds the table and PostgreSQL gets a plain
    # ALTER. The FK is named because SQLite cannot drop an unnamed one, which
    # would leave the downgrade unrunnable.
    with op.batch_alter_table("endpoints") as batch:
        batch.add_column(
            sa.Column("silenced_until", sa.DateTime(timezone=True), nullable=True)
        )
        batch.add_column(sa.Column("silence_reason", sa.String(255), nullable=True))
        batch.add_column(sa.Column("silenced_by_id", UUID, nullable=True))
        batch.create_foreign_key(
            "fk_endpoints_silenced_by_id_users",
            "users",
            ["silenced_by_id"],
            ["id"],
            # The record outlives the account: deleting a user must not fail,
            # and must not take the endpoint's configuration with it.
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("endpoints") as batch:
        batch.drop_constraint("fk_endpoints_silenced_by_id_users", type_="foreignkey")
        batch.drop_column("silenced_by_id")
        batch.drop_column("silence_reason")
        batch.drop_column("silenced_until")
