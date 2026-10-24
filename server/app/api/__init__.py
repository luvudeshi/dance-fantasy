"""HTTP API. Every route is mounted under /api."""

from fastapi import APIRouter

from app.api import health, songs, spike

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(songs.router)
api_router.include_router(spike.router)

__all__ = ["api_router"]
