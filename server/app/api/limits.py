"""Request limits: body size (pure ASGI middleware, so it also sees bodies before form parsing) and
the number of concurrent audio analyses."""

from __future__ import annotations

from collections.abc import Callable

import anyio
from fastapi import HTTPException, status
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


MAX_CONCURRENT_ANALYSES = 2
# Shared by every route that decodes/analyzes audio. Requests wait for a slot on the event loop,
# not inside a worker thread: the threadpool also serves audio downloads and every sync
# endpoint/dependency, so queued analyses must not hold it.
ANALYSIS_SLOTS = anyio.CapacityLimiter(MAX_CONCURRENT_ANALYSES)


class UploadTooLarge(HTTPException):
    """413 with a ``detail`` naming the configured upload limit."""

    def __init__(self, max_bytes: int) -> None:
        limit_mb = max_bytes / (1024 * 1024)
        super().__init__(status.HTTP_413_CONTENT_TOO_LARGE, f"Upload too large (limit {limit_mb:g} MB).")


class BodySizeLimitMiddleware:
    """Reject HTTP request bodies over ``max_bytes() + headroom`` with 413.

    Checks Content-Length up front and counts bytes while the body streams in, so an
    oversized upload is never spooled to disk in full. ``max_bytes`` is a callable so the
    limit follows the current settings; ``headroom`` leaves room for multipart framing (the
    route enforces the exact per-file limit). Non-HTTP scopes (WebSockets) pass through.
    """

    def __init__(self, app: ASGIApp, max_bytes: Callable[[], int], headroom: int = 0) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.headroom = headroom

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        max_bytes = self.max_bytes()
        limit = max_bytes + self.headroom
        declared = Headers(scope=scope).get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            await self._reject(max_bytes, scope, receive, send)
            return

        received = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise UploadTooLarge(max_bytes)
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except UploadTooLarge:
            # Normally FastAPI turns it into a 413 response itself; this covers bodies read
            # outside a route (e.g. by another middleware).
            if response_started:
                raise
            await self._reject(max_bytes, scope, receive, send)

    @staticmethod
    async def _reject(max_bytes: int, scope: Scope, receive: Receive, send: Send) -> None:
        exc = UploadTooLarge(max_bytes)
        response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers={"Connection": "close"})
        await response(scope, receive, send)
