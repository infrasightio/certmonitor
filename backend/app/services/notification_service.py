"""Alert delivery.

A generic webhook is the baseline mechanism required of the system; Slack,
Microsoft Teams, PagerDuty and SMTP e-mail are implemented on top of the same
channel abstraction, so adding another provider means adding one function to
``_DELIVERY`` rather than touching the alerting logic.

Channel configuration (webhook URLs, SMTP passwords, routing keys) is stored as
a single encrypted blob and is never returned to a client. Only
``config_public`` - host names, ports, recipient counts - is displayed.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage
from html import escape as _html_escape
from typing import Any, Callable, Coroutine
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    AlertType,
    NotificationChannelType,
    SEVERITY_ORDER,
    Severity,
    humanise_reason,
)
from app.core.logging import get_logger
from app.core.security import decrypt_secret, encrypt_secret
from app.models.alert import Alert, NotificationChannel

logger = get_logger(__name__)

DELIVERY_TIMEOUT_SECONDS = 15.0
MAX_ATTEMPTS = 3

_SEVERITY_COLOURS = {
    Severity.INFO.value: "#2563eb",
    Severity.WARNING.value: "#d97706",
    Severity.CRITICAL.value: "#dc2626",
}

# What the alert IS, in the words an operator would use, keyed by event rather
# than by severity - "Still failing" and "Endpoint down" are both critical but
# mean different things to whoever is reading at 2am. Unicode rather than
# Slack shortcodes so the same string works in the header block, the plain
# fallback and a push notification.
_EVENT_PRESENTATION: dict[str, tuple[str, str]] = {
    AlertType.ENDPOINT_DOWN.value: ("\U0001f534", "Endpoint down"),
    AlertType.ENDPOINT_RECOVERED.value: ("✅", "Recovered"),
    AlertType.HIGH_RESPONSE_TIME.value: ("\U0001f7e0", "Slow response"),
    AlertType.REPEATED_FAILURES.value: ("\U0001f501", "Still failing"),
    AlertType.SSL_EXPIRING.value: ("⏳", "Certificate expiring"),
    AlertType.SSL_EXPIRED.value: ("\U0001f512", "Certificate expired"),
    AlertType.SSL_INVALID.value: ("\U0001f512", "Certificate invalid"),
    "test": ("\U0001f514", "Test notification"),
}

_DEFAULT_PRESENTATION = ("\U0001f4e1", "Alert")


class NotificationError(RuntimeError):
    """Delivery failed; the alert row records the reason."""


# ------------------------------------------------------------ config crypto
_SECRET_KEYS_BY_TYPE: dict[str, set[str]] = {
    NotificationChannelType.WEBHOOK.value: {"url", "secret", "headers"},
    NotificationChannelType.SLACK.value: {"webhook_url"},
    NotificationChannelType.TEAMS.value: {"webhook_url"},
    NotificationChannelType.PAGERDUTY.value: {"routing_key"},
    NotificationChannelType.EMAIL.value: {"password"},
}

REQUIRED_CONFIG: dict[str, tuple[str, ...]] = {
    NotificationChannelType.WEBHOOK.value: ("url",),
    NotificationChannelType.SLACK.value: ("webhook_url",),
    NotificationChannelType.TEAMS.value: ("webhook_url",),
    NotificationChannelType.PAGERDUTY.value: ("routing_key",),
    NotificationChannelType.EMAIL.value: ("host", "from_address", "recipients"),
}


def validate_config(channel_type: str, config: dict[str, Any]) -> dict[str, Any]:
    """Check required keys and normalise a channel configuration."""
    if channel_type not in REQUIRED_CONFIG:
        raise ValueError(f"unsupported channel type '{channel_type}'")

    cleaned = dict(config or {})
    missing = [key for key in REQUIRED_CONFIG[channel_type] if not cleaned.get(key)]
    if missing:
        raise ValueError(
            f"{channel_type} channel requires: " + ", ".join(missing)
        )

    for url_key in ("url", "webhook_url"):
        if cleaned.get(url_key):
            parsed = urlsplit(str(cleaned[url_key]))
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                raise ValueError(f"{url_key} must be an absolute http(s) URL")

    if channel_type == NotificationChannelType.WEBHOOK.value:
        method = str(cleaned.get("method", "POST")).upper()
        if method not in ("POST", "PUT", "PATCH"):
            raise ValueError("webhook method must be POST, PUT or PATCH")
        cleaned["method"] = method
        headers = cleaned.get("headers") or {}
        if not isinstance(headers, dict):
            raise ValueError("webhook headers must be an object")
        cleaned["headers"] = {str(k): str(v) for k, v in headers.items()}

    if channel_type == NotificationChannelType.EMAIL.value:
        recipients = cleaned.get("recipients")
        if isinstance(recipients, str):
            recipients = [r.strip() for r in recipients.split(",") if r.strip()]
        if not isinstance(recipients, list) or not recipients:
            raise ValueError("email channel requires at least one recipient")
        cleaned["recipients"] = recipients
        cleaned["port"] = int(cleaned.get("port") or 587)
        cleaned["use_tls"] = bool(cleaned.get("use_tls", True))
        cleaned["use_ssl"] = bool(cleaned.get("use_ssl", False))

    return cleaned


def public_view(channel_type: str, config: dict[str, Any]) -> dict[str, Any]:
    """The subset of a config that is safe to show in the UI."""
    public: dict[str, Any] = {}
    if channel_type in (
        NotificationChannelType.WEBHOOK.value,
        NotificationChannelType.SLACK.value,
        NotificationChannelType.TEAMS.value,
    ):
        raw = config.get("url") or config.get("webhook_url") or ""
        parsed = urlsplit(str(raw))
        public["target_host"] = parsed.netloc or None
        public["target_scheme"] = parsed.scheme or None
        if channel_type == NotificationChannelType.WEBHOOK.value:
            public["method"] = config.get("method", "POST")
            public["custom_header_names"] = sorted((config.get("headers") or {}).keys())
            public["signed"] = bool(config.get("secret"))
    elif channel_type == NotificationChannelType.PAGERDUTY.value:
        public["routing_key_configured"] = bool(config.get("routing_key"))
    elif channel_type == NotificationChannelType.EMAIL.value:
        public.update(
            {
                "host": config.get("host"),
                "port": config.get("port"),
                "use_tls": config.get("use_tls"),
                "use_ssl": config.get("use_ssl"),
                "from_address": config.get("from_address"),
                "recipient_count": len(config.get("recipients") or []),
                "authenticated": bool(config.get("username")),
            }
        )
    return public


def encrypt_config(config: dict[str, Any]) -> str:
    return encrypt_secret(json.dumps(config))


def decrypt_config(blob: str | None) -> dict[str, Any] | None:
    if not blob:
        return None
    raw = decrypt_secret(blob)
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


# --------------------------------------------------------------- payloads
def build_payload(alert: Alert, *, base_url: str | None = None) -> dict[str, Any]:
    """Canonical JSON body used by the generic webhook channel.

    ``base_url`` is the ``public_base_url`` setting. When it is set the payload
    carries deep links back into the application, which is what turns a Slack
    alert from a statement into somewhere to go. When it is not, ``links`` is
    absent and every channel simply renders no link - a wrong link is worse
    than none, so nothing is guessed from a Host header.
    """
    endpoint = alert.endpoint
    links: dict[str, str] = {}
    if base_url:
        base = base_url.rstrip("/")
        links["app"] = base
        if endpoint is not None:
            links["endpoint"] = f"{base}/endpoints/{endpoint.id}"
        if alert.incident_id:
            links["incidents"] = f"{base}/incidents"
    return {
        "event": alert.alert_type,
        "severity": alert.severity,
        "title": alert.title,
        "message": alert.message,
        "occurred_at": (alert.created_at or datetime.now(timezone.utc)).isoformat(),
        "alert_id": alert.id,
        "incident_id": alert.incident_id,
        "endpoint": (
            {
                "id": str(endpoint.id),
                "name": endpoint.name,
                "url": endpoint.url,
                "hostname": endpoint.hostname,
                "environment": endpoint.environment.name if endpoint.environment else None,
                "tags": endpoint.tag_names,
                "owner": endpoint.owner,
                "team": endpoint.team,
                "current_status": endpoint.current_status,
            }
            if endpoint
            else None
        ),
        "details": alert.details or {},
        "links": links or None,
        "source": "infrasight",
    }


def _format_latency(value: Any) -> str:
    """Milliseconds, read the way an operator says them."""
    try:
        ms = float(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{ms:.0f} ms" if ms < 1000 else f"{ms / 1000:.2f} s"


def _format_seconds(value: Any) -> str:
    try:
        total = int(float(value))
    except (TypeError, ValueError):
        return str(value)
    if total < 60:
        return f"{total}s"
    minutes, seconds = divmod(total, 60)
    if minutes < 60:
        return f"{minutes}m {seconds}s" if seconds else f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}h {minutes}m" if minutes else f"{hours}h"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours}h" if hours else f"{days}d"


def _format_date(value: Any) -> str:
    """An ISO timestamp as a plain date. Anything else passes through."""
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).strftime(
            "%d %b %Y"
        )
    except (TypeError, ValueError):
        return str(value)


def _alert_link(payload: dict[str, Any]) -> str | None:
    """Where to send someone who wants to look at this now.

    The endpoint's own page when the alert is about an endpoint, the
    application otherwise. ``None`` when ``public_base_url`` is unset, and
    every channel then renders no link rather than a guess - a link that goes
    nowhere costs more trust than an absent one.
    """
    links = payload.get("links") or {}
    return links.get("endpoint") or links.get("app") or None


def _format_moment(value: Any) -> str:
    """A timestamp a person can read, in UTC.

    E-mail has no equivalent of Slack's per-viewer date token, so the zone is
    stated rather than implied - an unlabelled time in an alert is a trap.
    """
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return str(value)
    return moment.astimezone(timezone.utc).strftime("%d %b %Y at %H:%M UTC")


# key -> (label, formatter). Ordered by how useful each one is when triaging,
# because Slack shows at most ten fields and the first ones are what get read.
_DETAIL_FIELDS: tuple[tuple[str, str, Any], ...] = (
    ("failure_reason", "Reason", humanise_reason),
    ("error", "Error", str),
    ("http_status_code", "HTTP status", str),
    ("response_time_ms", "Response time", _format_latency),
    ("threshold_ms", "Threshold", _format_latency),
    ("consecutive_failures", "Failed checks", str),
    ("failed_checks", "Failed checks", str),
    ("downtime_seconds", "Downtime", _format_seconds),
    ("days_remaining", "Days remaining", str),
    ("expires_at", "Expires", _format_date),
    ("issuer", "Issuer", str),
)


def _summary_fields(payload: dict[str, Any]) -> list[tuple[str, str]]:
    """Label/value pairs shared by every channel that renders a summary."""
    endpoint = payload.get("endpoint") or {}
    details = payload.get("details") or {}
    fields: list[tuple[str, str]] = []
    if endpoint.get("url"):
        fields.append(("Endpoint", f"{endpoint.get('name')} ({endpoint['url']})"))
    if endpoint.get("environment"):
        fields.append(("Environment", str(endpoint["environment"])))
    message = payload.get("message") or ""
    for key, label, render in _DETAIL_FIELDS:
        value = details.get(key)
        if value is None or value == "":
            continue
        rendered = render(value)
        # Some alert types already spell the error out in their message -
        # endpoint_down does, repeated_failures does not. Repeating it as a
        # field would be noise in the first case and is the single most
        # diagnostic line in the second.
        if key == "error" and str(value) in message:
            continue
        fields.append((label, rendered[:300] if key == "error" else rendered))
    if endpoint.get("team"):
        fields.append(("Team", str(endpoint["team"])))
    if endpoint.get("owner"):
        fields.append(("Owner", str(endpoint["owner"])))
    return fields


# --------------------------------------------------------------- delivery
async def _deliver_webhook(config: dict[str, Any], payload: dict[str, Any]) -> None:
    body = json.dumps(payload, default=str).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "InfraSight/1.0"}
    headers.update(config.get("headers") or {})

    secret = config.get("secret")
    if secret:
        # HMAC-SHA256 over the exact bytes sent, so the receiver can verify
        # the payload actually came from this instance.
        signature = hmac.new(
            str(secret).encode("utf-8"), body, hashlib.sha256
        ).hexdigest()
        headers["X-InfraSight-Signature"] = f"sha256={signature}"
        # Sent alongside under the pre-rename name. A receiver written against
        # CertMonitor verifies this header, and dropping it would silently
        # break every existing webhook consumer on upgrade. Same value, so
        # verifying either one is correct.
        headers["X-CertMonitor-Signature"] = f"sha256={signature}"

    async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS, trust_env=False) as client:
        response = await client.request(
            config.get("method", "POST"),
            config["url"],
            content=body,
            headers=headers,
        )
    if response.status_code >= 400:
        raise NotificationError(
            f"webhook responded {response.status_code}: {response.text[:200]}"
        )


def _slack_escape(text: str) -> str:
    """Slack's three reserved characters. Everything else is literal."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _slack_timestamp(iso: str) -> str:
    """Render a timestamp in each reader's own timezone.

    Slack resolves the ``<!date^…>`` token per viewer, so a team spread across
    offsets stops doing arithmetic on a UTC string in the middle of an
    incident. Falls back to the raw value if the timestamp will not parse.
    """
    try:
        moment = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return _slack_escape(str(iso))
    epoch = int(moment.timestamp())
    readable = moment.strftime("%d %b %Y at %H:%M UTC")
    return f"<!date^{epoch}^{{date_short_pretty}} at {{time}}|{readable}>"


def _slack_subject(payload: dict[str, Any]) -> str:
    """The one line that says what this is about.

    The endpoint name links to the monitored URL, so the thing under
    discussion is one click away. The alert message usually opens with that
    same URL, which would then read twice in a row - so a leading copy is
    dropped and the remainder carries on from the linked name.
    """
    endpoint = payload.get("endpoint") or {}
    message = (payload.get("message") or "").strip()
    name = endpoint.get("name") or endpoint.get("hostname")
    url = endpoint.get("url")

    if not name:
        return _slack_escape(message)

    heading = (
        f"*<{_slack_escape(url)}|{_slack_escape(name)}>*"
        if url
        else f"*{_slack_escape(name)}*"
    )
    if url and message.startswith(url):
        # "https://host/ has now failed 12 checks" -> "Has now failed 12
        # checks", so the remainder reads as a sentence under the linked name
        # rather than as a fragment. Only the first character is touched;
        # `capitalize()` would lowercase the rest and wreck "TLS" and "DNS".
        message = message[len(url):].lstrip()
        if message:
            message = message[0].upper() + message[1:]
    if not message:
        return heading
    # A section's text caps at 3000 characters; leave room for the heading.
    return f"{heading}\n{_slack_escape(message)}"[:2900]


def _slack_blocks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    emoji, label = _EVENT_PRESENTATION.get(
        payload.get("event", ""), _DEFAULT_PRESENTATION
    )
    endpoint = payload.get("endpoint") or {}

    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            # plain_text: no markdown, 150 characters, and the emoji carries
            # the severity at a glance so the colour bar is not load-bearing
            # for anyone who cannot rely on it.
            "text": {"type": "plain_text", "text": f"{emoji} {label}"[:150], "emoji": True},
        },
        {"type": "section", "text": {"type": "mrkdwn", "text": _slack_subject(payload)}},
    ]

    # Two columns, and never the Endpoint row - the subject above already
    # names it, linked. Ten is Slack's hard limit on a fields array.
    fields = [
        {"type": "mrkdwn", "text": f"*{name}*\n{_slack_escape(str(value))}"[:2000]}
        for name, value in _summary_fields(payload)
        if name != "Endpoint"
    ][:10]
    if fields:
        blocks.append({"type": "section", "fields": fields})

    # Straight to the endpoint when we know it, otherwise the application
    # itself. Absent entirely when public_base_url is unset.
    links = payload.get("links") or {}
    target = _alert_link(payload)
    if target:
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Open in InfraSight"
                            if links.get("endpoint")
                            else "Open InfraSight",
                        },
                        "url": target,
                    }
                ],
            }
        )

    context = ["InfraSight"]
    if endpoint.get("environment"):
        context.append(_slack_escape(str(endpoint["environment"])))
    if payload.get("incident_id"):
        context.append(f"Incident #{payload['incident_id']}")
    stamp = _slack_timestamp(payload["occurred_at"]) if payload.get("occurred_at") else ""
    if stamp:
        context.append(stamp)
    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": "  ·  ".join(context)}],
        }
    )
    return blocks


async def _deliver_slack(config: dict[str, Any], payload: dict[str, Any]) -> None:
    emoji, label = _EVENT_PRESENTATION.get(
        payload.get("event", ""), _DEFAULT_PRESENTATION
    )
    endpoint = payload.get("endpoint") or {}
    subject = endpoint.get("name") or endpoint.get("hostname") or payload["title"]

    # No top-level `text`. With `attachments` present Slack renders it as the
    # message body AND the attachment below it, which is what made every alert
    # print its own title twice. `fallback` covers the push notification and
    # the sidebar preview without being rendered in the channel.
    body = {
        "attachments": [
            {
                "color": _SEVERITY_COLOURS.get(payload["severity"], "#6b7280"),
                "fallback": f"{emoji} {label}: {subject}",
                "blocks": _slack_blocks(payload),
            }
        ]
    }
    async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS, trust_env=False) as client:
        response = await client.post(config["webhook_url"], json=body)
    if response.status_code >= 400:
        raise NotificationError(
            f"Slack responded {response.status_code}: {response.text[:200]}"
        )


async def _deliver_teams(config: dict[str, Any], payload: dict[str, Any]) -> None:
    body = {
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        "themeColor": _SEVERITY_COLOURS.get(payload["severity"], "6b7280").lstrip("#"),
        "summary": payload["title"],
        "title": payload["title"],
        "text": payload.get("message") or "",
        "sections": [
            {
                "facts": [
                    {"name": label, "value": value}
                    for label, value in _summary_fields(payload)
                ]
            }
        ],
    }

    # A MessageCard action renders as a button in the Teams client. Both the
    # endpoint's own URL and its InfraSight page are offered where known, so
    # the reader can look at the thing or at what InfraSight saw.
    actions = []
    link = _alert_link(payload)
    if link:
        actions.append(
            {
                "@type": "OpenUri",
                "name": "Open in InfraSight",
                "targets": [{"os": "default", "uri": link}],
            }
        )
    endpoint_url = (payload.get("endpoint") or {}).get("url")
    if endpoint_url:
        actions.append(
            {
                "@type": "OpenUri",
                "name": "Open endpoint",
                "targets": [{"os": "default", "uri": endpoint_url}],
            }
        )
    if actions:
        body["potentialAction"] = actions

    async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS, trust_env=False) as client:
        response = await client.post(config["webhook_url"], json=body)
    if response.status_code >= 400:
        raise NotificationError(
            f"Teams responded {response.status_code}: {response.text[:200]}"
        )


_PAGERDUTY_SEVERITY = {
    Severity.INFO.value: "info",
    Severity.WARNING.value: "warning",
    Severity.CRITICAL.value: "critical",
}


async def _deliver_pagerduty(config: dict[str, Any], payload: dict[str, Any]) -> None:
    endpoint = payload.get("endpoint") or {}
    # Recovery events resolve the incident PagerDuty already has open, keyed by
    # endpoint id, rather than creating a new one.
    is_recovery = payload["event"] == "endpoint_recovered"
    dedup_key = f"infrasight:{endpoint.get('id') or payload['alert_id']}"
    body = {
        "routing_key": config["routing_key"],
        "event_action": "resolve" if is_recovery else "trigger",
        "dedup_key": dedup_key,
        "payload": {
            "summary": payload["title"][:1024],
            "severity": _PAGERDUTY_SEVERITY.get(payload["severity"], "warning"),
            "source": endpoint.get("hostname") or "infrasight",
            "component": endpoint.get("name"),
            "group": endpoint.get("environment"),
            "class": payload["event"],
            "custom_details": payload.get("details") or {},
        },
    }

    # Events v2 renders these on the PagerDuty incident itself, which is where
    # a responder is looking when they get paged at 3am.
    pd_links = []
    link = _alert_link(payload)
    if link:
        pd_links.append({"href": link, "text": "Open in InfraSight"})
    if endpoint.get("url"):
        pd_links.append({"href": endpoint["url"], "text": f"Endpoint: {endpoint['url']}"})
    if pd_links:
        body["links"] = pd_links
    async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS, trust_env=False) as client:
        response = await client.post(
            "https://events.pagerduty.com/v2/enqueue", json=body
        )
    if response.status_code >= 400:
        raise NotificationError(
            f"PagerDuty responded {response.status_code}: {response.text[:200]}"
        )


def _email_text(payload: dict[str, Any]) -> str:
    """The plain-text part.

    Not a formality. It is what a terminal mail client, a pager gateway and an
    SMS bridge actually show, so it carries the same facts as the HTML rather
    than a stub telling the reader to view the message elsewhere.
    """
    endpoint = payload.get("endpoint") or {}
    _emoji, label = _EVENT_PRESENTATION.get(
        payload.get("event", ""), _DEFAULT_PRESENTATION
    )
    subject = endpoint.get("name") or endpoint.get("hostname")

    lines = [f"{label.upper()}{f': {subject}' if subject else ''}", ""]
    if payload.get("message"):
        lines.extend([payload["message"], ""])
    for name, value in _summary_fields(payload):
        lines.append(f"  {name + ':':<18} {value}")

    target = _alert_link(payload)
    if target:
        lines.extend(["", f"Open in InfraSight: {target}"])
    lines.extend(
        ["", f"Occurred at {_format_moment(payload.get('occurred_at'))}", "", "-- InfraSight"]
    )
    return "\n".join(lines)


def _email_html(payload: dict[str, Any]) -> str:
    """The HTML part.

    Built the way transactional mail has to be built rather than the way a web
    page would be: one centred table, every style inline, no external asset of
    any kind. Mail clients strip stylesheets, ignore flex and grid, and block
    remote images by default - and this product is deployed on hosts with no
    internet, so a remote logo would be a broken icon rather than branding.
    """
    endpoint = payload.get("endpoint") or {}
    emoji, label = _EVENT_PRESENTATION.get(
        payload.get("event", ""), _DEFAULT_PRESENTATION
    )
    accent = _SEVERITY_COLOURS.get(payload["severity"], "#5e6880")

    name = endpoint.get("name") or endpoint.get("hostname") or ""
    url = endpoint.get("url")
    heading = _html_escape(name) if name else _html_escape(payload.get("title", ""))
    if name and url:
        heading = (
            f'<a href="{_html_escape(url, quote=True)}" '
            f'style="color:#1c2129;text-decoration:none;">{_html_escape(name)}</a>'
        )

    message = (payload.get("message") or "").strip()
    if url and message.startswith(url):
        message = message[len(url):].lstrip()
        if message:
            message = message[0].upper() + message[1:]

    rows = "".join(
        f'<tr>'
        f'<td style="padding:7px 16px 7px 0;color:#5e6880;font-size:13px;'
        f'white-space:nowrap;vertical-align:top;">{_html_escape(field)}</td>'
        f'<td style="padding:7px 0;color:#1c2129;font-size:13px;'
        f'vertical-align:top;">{_html_escape(str(value))}</td>'
        f'</tr>'
        for field, value in _summary_fields(payload)
        if field != "Endpoint"
    )

    # Every optional section is resolved to a string here rather than inline in
    # the template below. Conditionals nested inside a triple-quoted f-string
    # are a good way to ship broken markup that no test would catch.
    message_row = ""
    if message:
        message_row = (
            '<tr><td style="padding:14px 28px 0 28px;font-size:15px;'
            f'line-height:1.6;color:#3b4351;">{_html_escape(message)}</td></tr>'
        )

    fields_row = ""
    if rows:
        fields_row = (
            '<tr><td style="padding:22px 28px 0 28px;">'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'border="0" style="background:#f9fafc;border:1px solid #d6dbe5;'
            f'border-radius:8px;padding:6px 16px;">{rows}</table>'
            '</td></tr>'
        )

    target = _alert_link(payload)
    button = ""
    if target:
        button = (
            '<tr><td style="padding:24px 28px 0 28px;">'
            f'<a href="{_html_escape(target, quote=True)}" '
            'style="display:inline-block;background:#3e4cc6;color:#ffffff;'
            'font-size:14px;font-weight:600;text-decoration:none;'
            'padding:11px 20px;border-radius:6px;">Open in InfraSight</a>'
            '</td></tr>'
        )

    footer_parts = ["InfraSight"]
    if endpoint.get("environment"):
        footer_parts.append(_html_escape(str(endpoint["environment"])))
    if payload.get("incident_id"):
        footer_parts.append(f"Incident #{payload['incident_id']}")
    footer_parts.append(_html_escape(_format_moment(payload.get("occurred_at"))))

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Transactional mail is pinned to light. A client that inverts a coloured
     severity band produces something that reads as a different severity. -->
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>{_html_escape(payload.get("title", "InfraSight alert"))}</title>
</head>
<body style="margin:0;padding:0;background:#f2f4f8;">
<!-- Preheader: the grey line an inbox shows beside the subject. Hidden in the
     body itself, so it is not said twice. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">
{_html_escape(message or payload.get("title", ""))}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#f2f4f8;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
         style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d6dbe5;
                border-radius:10px;overflow:hidden;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

    <tr><td style="background:{accent};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>

    <tr><td style="padding:26px 28px 0 28px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:.08em;
                  text-transform:uppercase;color:{accent};">
        {emoji}&nbsp;{_html_escape(label)}
      </div>
      <div style="margin-top:6px;font-size:21px;font-weight:600;color:#1c2129;
                  line-height:1.3;word-break:break-word;">{heading}</div>
    </td></tr>

    {message_row}
    {fields_row}
    {button}

    <tr><td style="padding:24px 28px 26px 28px;">
      <div style="border-top:1px solid #d6dbe5;padding-top:14px;
                  font-size:12px;color:#78829a;">
        {' &middot; '.join(footer_parts)}
      </div>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>"""


def _send_email_blocking(config: dict[str, Any], payload: dict[str, Any]) -> None:
    message = EmailMessage()
    message["Subject"] = f"[{payload['severity'].upper()}] {payload['title']}"
    message["From"] = config["from_address"]
    message["To"] = ", ".join(config["recipients"])

    # Filterable without reading the body - a mail rule can route on these
    # rather than pattern-matching a subject line that may be reworded.
    message["X-InfraSight-Event"] = str(payload.get("event", ""))
    message["X-InfraSight-Severity"] = str(payload.get("severity", ""))

    # Thread every alert about one incident together. "Endpoint DOWN" and the
    # "Recovered" that follows it belong in one conversation, not as two
    # unrelated messages twenty minutes apart.
    if payload.get("incident_id"):
        thread_id = f"<infrasight-incident-{payload['incident_id']}@infrasight.local>"
        message["References"] = thread_id
        message["In-Reply-To"] = thread_id

    # Order matters: set_content makes text/plain the body, add_alternative
    # promotes the message to multipart/alternative with HTML preferred.
    message.set_content(_email_text(payload))
    message.add_alternative(_email_html(payload), subtype="html")

    host = config["host"]
    port = int(config.get("port") or 587)
    timeout = DELIVERY_TIMEOUT_SECONDS

    if config.get("use_ssl"):
        server = smtplib.SMTP_SSL(host, port, timeout=timeout)
    else:
        server = smtplib.SMTP(host, port, timeout=timeout)
    try:
        server.ehlo()
        if config.get("use_tls") and not config.get("use_ssl"):
            server.starttls()
            server.ehlo()
        if config.get("username"):
            server.login(config["username"], config.get("password") or "")
        server.send_message(message)
    finally:
        try:
            server.quit()
        except Exception:  # pragma: no cover
            pass


async def _deliver_email(config: dict[str, Any], payload: dict[str, Any]) -> None:
    # smtplib is blocking; run it off the event loop so a slow mail server
    # cannot stall the worker.
    try:
        await asyncio.wait_for(
            asyncio.to_thread(_send_email_blocking, config, payload),
            timeout=DELIVERY_TIMEOUT_SECONDS * 2,
        )
    except asyncio.TimeoutError as exc:
        raise NotificationError("SMTP delivery timed out") from exc
    except smtplib.SMTPException as exc:
        raise NotificationError(f"SMTP error: {exc}") from exc
    except OSError as exc:
        raise NotificationError(f"SMTP connection failed: {exc}") from exc


_DELIVERY: dict[str, Callable[[dict[str, Any], dict[str, Any]], Coroutine[Any, Any, None]]] = {
    NotificationChannelType.WEBHOOK.value: _deliver_webhook,
    NotificationChannelType.SLACK.value: _deliver_slack,
    NotificationChannelType.TEAMS.value: _deliver_teams,
    NotificationChannelType.PAGERDUTY.value: _deliver_pagerduty,
    NotificationChannelType.EMAIL.value: _deliver_email,
}


# ------------------------------------------------------------- orchestration
def channel_matches(channel: NotificationChannel, alert: Alert) -> bool:
    """Apply a channel's severity, event, environment and tag filters."""
    if not channel.is_enabled:
        return False
    if SEVERITY_ORDER.get(alert.severity, 1) < SEVERITY_ORDER.get(
        channel.min_severity, 1
    ):
        return False
    if channel.event_types and alert.alert_type not in channel.event_types:
        return False

    endpoint = alert.endpoint
    if channel.environment_filter:
        env_name = endpoint.environment.name if endpoint and endpoint.environment else None
        if env_name not in channel.environment_filter:
            return False
    if channel.tag_filter:
        endpoint_tags = set(endpoint.tag_names) if endpoint else set()
        if not endpoint_tags & set(channel.tag_filter):
            return False
    return True


async def deliver_to_channel(
    channel: NotificationChannel, alert: Alert, payload: dict[str, Any]
) -> None:
    config = decrypt_config(channel.config_encrypted)
    if config is None:
        raise NotificationError(
            "channel configuration could not be decrypted - it must be re-entered "
            "after an encryption key change"
        )
    handler = _DELIVERY.get(channel.channel_type)
    if handler is None:
        raise NotificationError(f"no handler for channel type '{channel.channel_type}'")

    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            await handler(config, payload)
            return
        except (NotificationError, httpx.HTTPError, OSError) as exc:
            last_error = exc
            if attempt < MAX_ATTEMPTS:
                # Exponential backoff: a transient 502 from a webhook receiver
                # should not lose the alert.
                await asyncio.sleep(min(2 ** attempt, 8))
    raise NotificationError(str(last_error) if last_error else "delivery failed")


async def dispatch_alert(
    session: AsyncSession, alert: Alert, *, config: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Send one alert to every channel that matches it.

    Updates the alert's notification bookkeeping. Returns a per-channel result
    summary; never raises, because a failed notification must not roll back the
    monitoring result that produced it.
    """
    channels = (
        await session.execute(
            select(NotificationChannel).where(NotificationChannel.is_enabled.is_(True))
        )
    ).scalars().all()

    matching = [ch for ch in channels if channel_matches(ch, alert)]
    if not matching:
        alert.notification_status = "skipped"
        return {"delivered": 0, "failed": 0, "channels": []}

    payload = build_payload(alert, base_url=(config or {}).get("public_base_url"))
    results: list[dict[str, Any]] = []
    delivered = failed = 0

    for channel in matching:
        alert.notification_attempts += 1
        try:
            await deliver_to_channel(channel, alert, payload)
            channel.success_count += 1
            channel.last_used_at = datetime.now(timezone.utc)
            channel.last_error = None
            delivered += 1
            results.append({"channel": channel.name, "status": "delivered"})
        except Exception as exc:
            channel.failure_count += 1
            channel.last_error = str(exc)[:1000]
            failed += 1
            results.append(
                {"channel": channel.name, "status": "failed", "error": str(exc)[:300]}
            )
            logger.warning(
                "notification_failed",
                channel=channel.name,
                channel_type=channel.channel_type,
                alert_type=alert.alert_type,
                error=str(exc),
            )

    if delivered and not failed:
        alert.notification_status = "sent"
    elif delivered:
        alert.notification_status = "partial"
    else:
        alert.notification_status = "failed"
    alert.notification_error = next(
        (r.get("error") for r in results if r["status"] == "failed"), None
    )
    if delivered:
        alert.notified_at = datetime.now(timezone.utc)

    return {"delivered": delivered, "failed": failed, "channels": results}


async def send_test_notification(
    channel: NotificationChannel, *, base_url: str | None = None
) -> None:
    """Deliver a synthetic payload so an operator can verify a channel.

    Shaped like a real alert, including the link, so the test proves the
    formatting and not merely that the webhook URL resolves.
    """
    payload = {
        "event": "test",
        "severity": Severity.INFO.value,
        "title": f"InfraSight test notification ({channel.name})",
        "message": (
            f"Delivery to *{channel.name}* is working. Real alerts will look "
            "like this."
        ),
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "alert_id": 0,
        "incident_id": None,
        "endpoint": None,
        "details": {"channel_type": channel.channel_type},
        "links": {"app": base_url.rstrip("/")} if base_url else None,
        "source": "infrasight",
    }
    config = decrypt_config(channel.config_encrypted)
    if config is None:
        raise NotificationError("channel configuration could not be decrypted")
    handler = _DELIVERY.get(channel.channel_type)
    if handler is None:
        raise NotificationError(f"no handler for channel type '{channel.channel_type}'")
    await handler(config, payload)
