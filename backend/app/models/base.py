"""Declarative base, shared column types and mixins."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, Integer, MetaData, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON, TypeDecorator

# Explicit, predictable constraint names keep Alembic autogenerate diffs clean.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_N_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

# JSONB on PostgreSQL (indexable, binary) and plain JSON elsewhere so the test
# suite can run on SQLite.
JSONType = JSON().with_variant(JSONB, "postgresql")

class UtcDateTime(TypeDecorator):
    """A timezone-aware UTC timestamp, on every dialect.

    PostgreSQL's ``TIMESTAMP WITH TIME ZONE`` hands back aware datetimes.
    SQLite has no such type: it ignores ``timezone=True`` and returns naive
    ones. The application treats these columns as aware throughout - it
    subtracts two of them, and compares them against
    ``datetime.now(timezone.utc)`` - so under SQLite that code raised
    ``TypeError: can't subtract offset-naive and offset-aware datetimes``.

    That made the difference invisible where it mattered most: the test suite
    runs on SQLite, so the paths doing the arithmetic could not be exercised
    there at all, while the same code was fine in production.

    Binding normalises to UTC, loading re-attaches it, so the invariant the
    rest of the codebase assumes actually holds. The DDL is unchanged - the
    decorator delegates it to ``DateTime(timezone=True)`` - so no migration is
    involved.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            # A naive value reaching the database is a bug somewhere upstream,
            # but silently storing it as local time would be the worse answer.
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


# Always store timezone-aware UTC timestamps.
TimestampTZ = UtcDateTime()

# SQLite has no autoincrementing BIGINT - only INTEGER PRIMARY KEY - so the
# high-volume tables map to INTEGER there and BIGINT on PostgreSQL. Without
# this, the test suite could not insert monitoring results.
BigIntType = BigInteger().with_variant(Integer, "sqlite")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        pk = getattr(self, "id", None)
        return f"<{type(self).__name__} id={pk}>"


class UUIDPrimaryKeyMixin:
    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        TimestampTZ,
        nullable=False,
        default=utcnow,
        server_default=func.now(),
        index=True,
    )
    updated_at: Mapped[datetime] = mapped_column(
        TimestampTZ,
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
        server_default=func.now(),
    )
