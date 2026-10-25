"""Badges (shared/README.md, "Badges endpoints"): the catalog, and the signed-in dancer's earned and locked badges."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from app.accounts import store
from app.api.accounts import COOKIE
from app.badges import CATALOG, Badge, MyBadges, my_badges

router = APIRouter(tags=["badges"])


@router.get("/badges")
def catalog() -> list[Badge]:
    return [r.badge for r in CATALOG]


@router.get("/me/badges")
def mine(request: Request) -> MyBadges:
    now = time.time_ns() // 1_000_000
    # ponytail: no rate limit; like GET /api/me/history it is a few indexed reads plus <= 16 idempotent inserts.
    return store._authed(request.cookies.get(COOKIE), now, lambda tx, me: my_badges(tx, me["id"], now))
