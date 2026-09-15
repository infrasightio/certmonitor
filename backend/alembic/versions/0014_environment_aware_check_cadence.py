"""Re-base the healthy check cadence on five minutes.

The monitor used to check everything at one minute. That is the right cadence
for production and mostly wasted work everywhere else, so the schedule is now
resolved per check (``monitoring_service.resolve_check_interval``):

* an endpoint in a fast-check environment (production, by default) runs at
  ``fast_check_interval`` whether it is passing or failing,
* anything else that has just failed runs at ``failure_recheck_interval``
  until it passes,
* anything else runs at its own interval.

The three settings rows behind that are created by ``ensure_seeded`` on the
next boot, so they are not inserted here. What *is* done here is the part
``ensure_seeded`` deliberately will not do: move existing rows off the old
one-minute default onto the new five-minute one.

Only rows still sitting on exactly 60 seconds are touched, and only outside
the fast-check environments - anything deliberately tuned to another value is
left alone. An endpoint that genuinely wants 60 seconds in staging can be set
back to it, and the downgrade below reverses this wholesale.

Revision ID: 0014
Revises: 0013
Created: 2026-09-15
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_DEFAULT_INTERVAL = 60
NEW_DEFAULT_INTERVAL = 300

# Kept in step with settings_service's ``fast_check_environments`` default.
# Written literally rather than imported: a migration has to keep working
# when the application default later changes.
FAST_ENVIRONMENTS = ("production",)


def upgrade() -> None:
    connection = op.get_bind()

    # The default applied to endpoints created from here on.
    connection.execute(
        sa.text(
            "UPDATE system_settings SET value = :new "
            "WHERE key = 'default_monitor_interval' AND value = :old"
        ),
        {"new": str(NEW_DEFAULT_INTERVAL), "old": str(OLD_DEFAULT_INTERVAL)},
    )

    # Endpoints already created against it. NOT EXISTS rather than NOT IN so
    # an endpoint with no environment is included: it is not production, so it
    # moves to five minutes with the rest, whereas `NOT IN (NULL, ...)` would
    # silently exclude it.
    connection.execute(
        sa.text(
            "UPDATE endpoints SET interval_seconds = :new "
            "WHERE interval_seconds = :old "
            "AND NOT EXISTS ("
            "  SELECT 1 FROM environments e"
            "  WHERE e.id = endpoints.environment_id"
            "    AND lower(e.name) IN :fast"
            ")"
        ).bindparams(sa.bindparam("fast", expanding=True)),
        {
            "new": NEW_DEFAULT_INTERVAL,
            "old": OLD_DEFAULT_INTERVAL,
            "fast": list(FAST_ENVIRONMENTS),
        },
    )


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "UPDATE system_settings SET value = :old "
            "WHERE key = 'default_monitor_interval' AND value = :new"
        ),
        {"new": str(NEW_DEFAULT_INTERVAL), "old": str(OLD_DEFAULT_INTERVAL)},
    )
    connection.execute(
        sa.text("UPDATE endpoints SET interval_seconds = :old WHERE interval_seconds = :new"),
        {"new": NEW_DEFAULT_INTERVAL, "old": OLD_DEFAULT_INTERVAL},
    )
