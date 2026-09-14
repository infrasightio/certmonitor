"""What a hostname actually resolves to, and what those addresses are.

Answers "what am I really connecting to" for one endpoint: every address
behind the name, which one the last check used, what each one's reverse DNS
says it is, and whether it is routable at all.

Everything here uses the resolver the checks already use. There is no
geolocation and no third-party lookup: a private address has no region for
anyone to return, and posting the fleet's addresses to an external service
to find that out would trade the property that nothing leaves this machine
for an answer that is mostly "unknown".
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from time import perf_counter
from typing import Any

from app.core.logging import get_logger

logger = get_logger(__name__)

# Reverse lookups are best-effort garnish, not the answer. Internal PTR zones
# are frequently absent or slow, so each one is capped hard and a miss is
# reported as a miss rather than holding up the response.
REVERSE_DNS_TIMEOUT = 2.0
RESOLVE_TIMEOUT = 5.0


def classify_address(address: str) -> dict[str, Any]:
    """Family and routability of one address, decided locally."""
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return {"family": "unknown", "scope": "invalid", "is_global": False}

    if parsed.is_loopback:
        scope = "loopback"
    elif parsed.is_link_local:
        scope = "link-local"
    elif parsed.is_multicast:
        scope = "multicast"
    elif parsed.is_reserved or parsed.is_unspecified:
        scope = "reserved"
    elif parsed.is_private:
        scope = "private"
    else:
        scope = "public"

    return {
        "family": f"IPv{parsed.version}",
        "scope": scope,
        "is_global": bool(parsed.is_global),
    }


async def reverse_dns(address: str) -> str | None:
    """PTR for one address, or None when there isn't one."""
    loop = asyncio.get_running_loop()
    try:
        host, _ = await asyncio.wait_for(
            loop.getnameinfo((address, 0), socket.NI_NAMEREQD),
            timeout=REVERSE_DNS_TIMEOUT,
        )
    except (asyncio.TimeoutError, socket.gaierror, OSError):
        return None
    # getnameinfo hands back the address itself when it cannot do better.
    return None if host == address else host


async def resolve_all(hostname: str, port: int) -> tuple[list[str], float, str | None]:
    """Every address behind a name, IPv4 first, with how long it took."""
    started = perf_counter()
    if _is_ip_literal(hostname):
        return [hostname], 0.0, None

    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(
            loop.getaddrinfo(hostname, port, type=socket.SOCK_STREAM),
            timeout=RESOLVE_TIMEOUT,
        )
    except asyncio.TimeoutError:
        return [], _elapsed(started), f"DNS resolution timed out after {RESOLVE_TIMEOUT:g}s"
    except socket.gaierror as exc:
        return [], _elapsed(started), f"DNS resolution failed: {exc.strerror or exc}"
    except OSError as exc:
        return [], _elapsed(started), f"DNS resolution failed: {exc}"

    ipv4 = [i[4][0] for i in infos if i[0] == socket.AF_INET]
    ipv6 = [i[4][0] for i in infos if i[0] == socket.AF_INET6]
    ordered = list(dict.fromkeys(ipv4 + ipv6))
    if not ordered:
        return [], _elapsed(started), "resolver returned no addresses"
    return ordered, _elapsed(started), None


async def inspect_host(
    hostname: str, port: int, *, in_use: str | None = None
) -> dict[str, Any]:
    """The full picture for one hostname.

    ``in_use`` is the address the most recent check actually connected to,
    so a name behind a load balancer shows which of its addresses is the one
    the recorded timings and certificate belong to.
    """
    addresses, elapsed, error = await resolve_all(hostname, port)

    # One lookup per address, concurrently - a name with six A records should
    # not cost six sequential timeouts when none of them have a PTR.
    names = await asyncio.gather(*(reverse_dns(a) for a in addresses))

    return {
        "hostname": hostname,
        "port": port,
        "is_ip_literal": _is_ip_literal(hostname),
        "resolution_ms": elapsed,
        "error": error,
        "addresses": [
            {
                "address": address,
                "reverse_dns": name,
                "in_use": address == in_use,
                **classify_address(address),
            }
            for address, name in zip(addresses, names)
        ],
    }


def _is_ip_literal(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _elapsed(started: float) -> float:
    return round((perf_counter() - started) * 1000, 1)
