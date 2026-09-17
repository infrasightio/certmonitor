"""Render a monitored page to a JPEG.

Entirely optional. Playwright and its Chromium are a large dependency, and a
deployment that does not want them should still run: every import here is lazy
and every failure degrades to a recorded reason rather than an exception. If
Chromium is missing, screenshots are simply never produced and the endpoint
detail view says why.

Three things keep this from becoming the reason monitoring stops:

* one browser process for the lifetime of the worker, not one per capture -
  launching Chromium costs about a second and a lot of page faults;
* a small semaphore, separate from the worker's 50 check slots, because 50
  concurrent Chromium pages is several gigabytes;
* a hard timeout on every step, so a page that never finishes loading is
  abandoned rather than held.

The render runs AFTER the check has been recorded and committed, so a slow
page can never delay the thing that actually matters.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


@dataclass
class Shot:
    """A rendered page, or the reason there is not one."""

    image: bytes | None = None
    width: int | None = None
    height: int | None = None
    error: str | None = None
    # What the browser's OWN request got back. This is a second request to the
    # endpoint, made seconds after the check and answered independently of it,
    # so it can differ from the status the check recorded - and on a flapping
    # endpoint it routinely does. Kept so the caller can tell whether this
    # picture is of the response it is about to be filed under.
    status: int | None = None

    @property
    def ok(self) -> bool:
        return self.image is not None


class _Renderer:
    """Owns the one browser process, and hands out pages under a semaphore."""

    def __init__(self) -> None:
        self._playwright = None
        self._browser = None
        self._lock = asyncio.Lock()
        self._semaphore: asyncio.Semaphore | None = None
        # Set once when Chromium turns out not to be available, so a fleet of
        # endpoints with screenshots on does not produce one traceback per
        # check forever.
        self._unavailable: str | None = None

    def _limit(self) -> asyncio.Semaphore:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(max(1, settings.SCREENSHOT_CONCURRENCY))
        return self._semaphore

    async def _browser_or_reason(self):
        """The shared browser, launching it on first use. None with a reason set."""
        if self._unavailable:
            return None
        if self._browser is not None and self._browser.is_connected():
            return self._browser

        async with self._lock:
            # Another caller may have won the race while we waited.
            if self._unavailable:
                return None
            if self._browser is not None and self._browser.is_connected():
                return self._browser

            try:
                from playwright.async_api import async_playwright
            except ImportError:
                self._unavailable = (
                    "Playwright is not installed in this image, so screenshots "
                    "cannot be rendered."
                )
                logger.warning("screenshots_unavailable", reason="playwright_missing")
                return None

            try:
                self._playwright = await async_playwright().start()
                self._browser = await self._playwright.chromium.launch(
                    headless=True,
                    # The container is the sandbox. Chromium's own sandbox
                    # needs privileges this image deliberately does not have,
                    # and the alternative is running the worker as root.
                    args=[
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
                    ],
                )
            except Exception as exc:
                self._unavailable = (
                    "Chromium could not be started, so screenshots cannot be "
                    "rendered."
                )
                logger.warning(
                    "screenshots_unavailable",
                    reason="launch_failed",
                    error=str(exc)[:300],
                )
                return None

            logger.info("screenshot_browser_started")
            return self._browser

    async def capture(
        self,
        url: str,
        *,
        verify_ssl: bool = True,
        headers: dict[str, str] | None = None,
    ) -> Shot:
        """Render ``url``, or come back with the reason it could not be.

        Never raises. A screenshot is an enrichment - nothing about a check's
        result depends on it, so every failure mode here is data, not an
        exception.
        """
        browser = await self._browser_or_reason()
        if browser is None:
            return Shot(error=self._unavailable)

        timeout_ms = max(1000, settings.SCREENSHOT_TIMEOUT_SECONDS * 1000)
        context = None
        try:
            async with self._limit():
                context = await browser.new_context(
                    viewport={
                        "width": settings.SCREENSHOT_WIDTH,
                        "height": settings.SCREENSHOT_HEIGHT,
                    },
                    # A monitored endpoint may legitimately serve a self-signed
                    # or expired certificate - that is a finding the SSL side of
                    # this product reports on, not a reason to refuse to
                    # photograph the page. Follows the endpoint's own setting.
                    ignore_https_errors=not verify_ssl,
                    user_agent=settings.SCREENSHOT_USER_AGENT,
                    extra_http_headers=headers or {},
                    # No point rendering animations for a still.
                    reduced_motion="reduce",
                )
                page = await context.new_page()
                # `load` rather than `networkidle`: a page that polls - which a
                # dashboard usually does - never goes idle, and waiting for it
                # to would time out on exactly the pages worth looking at.
                response = await page.goto(url, wait_until="load", timeout=timeout_ms)
                image = await page.screenshot(
                    type="jpeg",
                    quality=settings.SCREENSHOT_QUALITY,
                    full_page=False,
                    timeout=timeout_ms,
                )
                return Shot(
                    image=image,
                    width=settings.SCREENSHOT_WIDTH,
                    height=settings.SCREENSHOT_HEIGHT,
                    # None when the navigation produced no response of its own
                    # (a same-document navigation, or a download). The caller
                    # treats that as "cannot tell" rather than as a failure.
                    status=response.status if response is not None else None,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Playwright's own timeout is an ordinary exception here. The
            # message is useful to whoever is looking at the endpoint, so it is
            # kept rather than flattened to "failed".
            reason = type(exc).__name__
            detail = str(exc).strip().splitlines()[0] if str(exc).strip() else reason
            logger.info(
                "screenshot_failed", url=url, error=detail[:200], kind=reason
            )
            return Shot(error=detail[:255])
        finally:
            if context is not None:
                try:
                    await context.close()
                except Exception:  # pragma: no cover - teardown is best effort
                    pass

    async def shutdown(self) -> None:
        """Close the browser on worker shutdown, so no Chromium is orphaned."""
        browser, playwright = self._browser, self._playwright
        self._browser = self._playwright = None
        if browser is not None:
            try:
                await browser.close()
            except Exception:  # pragma: no cover
                pass
        if playwright is not None:
            try:
                await playwright.stop()
            except Exception:  # pragma: no cover
                pass


_renderer = _Renderer()


async def capture(
    url: str, *, verify_ssl: bool = True, headers: dict[str, str] | None = None
) -> Shot:
    return await _renderer.capture(url, verify_ssl=verify_ssl, headers=headers)


async def shutdown() -> None:
    await _renderer.shutdown()
