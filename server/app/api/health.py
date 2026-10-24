"""Liveness check."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app import __version__

router = APIRouter(tags=["health"])


class Health(BaseModel):
    status: Literal["ok"] = "ok"
    version: str


@router.get("/health")
async def health() -> Health:
    return Health(version=__version__)
