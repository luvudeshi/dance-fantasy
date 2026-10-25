"""HTTP API. Every route is mounted under /api."""

from fastapi import APIRouter

from app.api import analyze, choreograph, health, moves, songs, spike

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(songs.router)
api_router.include_router(spike.router)
api_router.include_router(analyze.router)
api_router.include_router(choreograph.router)
api_router.include_router(moves.router)

__all__ = ["api_router"]
