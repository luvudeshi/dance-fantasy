"""FastAPI application: ``uv run uvicorn app.main:app --reload --port 8000``."""

from __future__ import annotations

import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.api import api_router
from app.api.limits import BodySizeLimitMiddleware
from app.config import get_settings
from app.warm import warm_caches

MULTIPART_OVERHEAD_BYTES = 64 * 1024  # headroom for boundaries/headers around an upload


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # numba compiles librosa's beat tracker on first use (seconds), and library songs are analyzed
    # ahead of time so demo songs start instantly; both happen off the startup path.
    threading.Thread(target=warm_caches, name="cache-warmup", daemon=True).start()
    yield


async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Bad input is a 400 with a string ``detail`` (shared/README.md), not FastAPI's 422 list."""
    parts = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ()))
        parts.append(f"{loc}: {err.get('msg', 'invalid')}" if loc else str(err.get("msg", "invalid")))
    return JSONResponse({"detail": "; ".join(parts) or "Invalid request."}, status_code=status.HTTP_400_BAD_REQUEST)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Midnight Ball API", version=__version__, lifespan=lifespan)
    app.add_exception_handler(RequestValidationError, _validation_error)
    # Added first = inner: CORS stays outermost so even 413s carry CORS headers.
    app.add_middleware(
        BodySizeLimitMiddleware, max_bytes=lambda: get_settings().max_upload_bytes, headroom=MULTIPART_OVERHEAD_BYTES
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router)
    return app


app = create_app()
