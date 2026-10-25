"""HTTP API. Every route is mounted under /api."""

from fastapi import APIRouter

from app.api import analyze, announcer, choreograph, health, moves, rooms, signature, songs, spike

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(signature.router)  # before songs: /songs/signature vs /songs/{file}
api_router.include_router(songs.router)
api_router.include_router(spike.router)
api_router.include_router(analyze.router)
api_router.include_router(choreograph.router)
api_router.include_router(moves.router)
api_router.include_router(rooms.router)
api_router.include_router(rooms.heatmap_router)
api_router.include_router(announcer.router)

__all__ = ["api_router"]
