"""Configuration guards.

These build `Settings` directly rather than going through the app, because
what is under test is whether the process is allowed to start at all.
"""

from __future__ import annotations

import pytest

from app.core.config import GENERATED_SECRET_PREFIX, Settings


@pytest.fixture
def build(monkeypatch):
    """Build a Settings with nothing inherited from the test environment.

    `conftest` exports JWT_SECRET for the API tests and a developer may have a
    local `.env`; either would decide the result of these tests instead of the
    code under test. Both are removed, and every relevant field is passed
    explicitly.
    """
    monkeypatch.delenv("JWT_SECRET", raising=False)
    monkeypatch.delenv("ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)

    def _build(**overrides) -> Settings:
        base = {
            "_env_file": None,
            "DATABASE_URL": "postgresql+asyncpg://u:p@db:5432/infrasight",
        }
        base.update(overrides)
        return Settings(**base)

    return _build


class TestJwtSecret:
    def test_a_missing_secret_is_generated_and_marked(self, build):
        settings = build(APP_ENV="development")
        assert settings.jwt_secret_is_generated is True
        assert settings.JWT_SECRET.startswith(GENERATED_SECRET_PREFIX)

    def test_a_supplied_secret_is_not_marked_as_generated(self, build):
        settings = build(APP_ENV="development", JWT_SECRET="a" * 48)
        assert settings.jwt_secret_is_generated is False

    @pytest.mark.parametrize("environment", ["production", "staging"])
    def test_production_refuses_to_start_without_a_secret(self, build, environment):
        """The important one.

        A generated secret is 64 characters and passes any strength check, but
        differs per process and per restart - so replicas reject each other's
        tokens and encrypted credentials become unreadable. Failing to start is
        the only outcome that surfaces it before data is lost.
        """
        with pytest.raises(ValueError, match="JWT_SECRET is not set"):
            build(APP_ENV=environment)

    @pytest.mark.parametrize("environment", ["production", "staging"])
    def test_production_starts_with_a_supplied_secret(self, build, environment):
        settings = build(APP_ENV=environment, JWT_SECRET="b" * 48)
        assert settings.is_production is True
        assert settings.jwt_secret_is_generated is False

    @pytest.mark.parametrize("environment", ["development", "testing"])
    def test_other_environments_still_boot_without_one(self, build, environment):
        """A dev container must not need a secret to come up."""
        settings = build(APP_ENV=environment)
        assert settings.is_production is False
        assert settings.jwt_secret_is_generated is True

    def test_a_short_supplied_secret_is_allowed_through(self, build):
        """Weak, but the operator chose it, and existing deployments have one.

        Startup logs `weak_jwt_secret`; it is not fatal, because refusing here
        would take down a running instance on upgrade over something that is
        merely ill-advised rather than silently destructive.
        """
        settings = build(APP_ENV="production", JWT_SECRET="short")
        assert settings.jwt_secret_is_generated is False
