"""HTTP API. Every route is mounted under /api."""

from fastapi import APIRouter

from app.api import analyze, health, songs, spike

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(songs.router)
api_router.include_router(spike.router)
api_router.include_router(analyze.router)

__all__ = ["api_router"]
