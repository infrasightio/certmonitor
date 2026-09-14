"""Address classification and host inspection.

The classification is the part worth testing: it decides whether an operator
is told an address is routable, and it is the same judgement the checker uses
to refuse a target.
"""

from __future__ import annotations

import pytest

from app.monitoring.network import classify_address, inspect_host


class TestClassifyAddress:
    @pytest.mark.parametrize(
        "address,family,scope",
        [
            ("8.8.8.8", "IPv4", "public"),
            ("10.0.1.4", "IPv4", "private"),
            ("192.168.1.10", "IPv4", "private"),
            ("172.16.0.1", "IPv4", "private"),
            ("127.0.0.1", "IPv4", "loopback"),
            ("169.254.169.254", "IPv4", "link-local"),
            ("224.0.0.1", "IPv4", "multicast"),
            ("2001:4860:4860::8888", "IPv6", "public"),
            ("::1", "IPv6", "loopback"),
        ],
    )
    def test_scopes(self, address, family, scope):
        result = classify_address(address)
        assert result["family"] == family
        assert result["scope"] == scope

    def test_a_private_address_is_not_global(self):
        """The distinction the UI leans on: no geolocation exists for these."""
        assert classify_address("10.0.1.4")["is_global"] is False
        assert classify_address("8.8.8.8")["is_global"] is True

    def test_nonsense_is_reported_not_raised(self):
        result = classify_address("not-an-address")
        assert result["scope"] == "invalid"
        assert result["is_global"] is False


class TestInspectHost:
    async def test_an_ip_literal_needs_no_resolution(self):
        result = await inspect_host("10.0.1.4", 443)

        assert result["is_ip_literal"] is True
        assert result["error"] is None
        assert [row["address"] for row in result["addresses"]] == ["10.0.1.4"]
        assert result["addresses"][0]["scope"] == "private"

    async def test_a_name_that_does_not_resolve_reports_why(self):
        result = await inspect_host("this-name-should-not-resolve.invalid", 443)

        assert result["addresses"] == []
        assert result["error"]

    async def test_the_address_in_use_is_marked(self):
        result = await inspect_host("10.0.1.4", 443, in_use="10.0.1.4")
        assert result["addresses"][0]["in_use"] is True

        other = await inspect_host("10.0.1.4", 443, in_use="10.0.9.9")
        assert other["addresses"][0]["in_use"] is False
