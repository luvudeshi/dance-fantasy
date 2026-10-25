"""Accounts (shared/README.md, "Accounts endpoints"): guest sessions, optional login, profile, friends, history.

The session is the httpOnly ``df_session`` cookie, so the web app must reach the API same-origin
(the Vite proxy in dev, one Vercel deployment in production). CSRF: on top of SameSite=Lax, every
non-GET route here demands the ``X-DF: 1`` header, which a cross-site form cannot send.
Sync handlers on purpose: the database calls block, so FastAPI runs them in its threadpool.
"""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, status

from app.accounts import store
from app.api.limits import client_ip
from app.accounts.models import (
    ACCOUNT_ID_PATTERN,
    Credentials,
    Friend,
    FriendCodeBody,
    History,
    Invite,
    Me,
    Partner,
    ProfilePatch,
    RoomCodeBody,
    RoomRecordBody,
    RoundBody,
)
from app.rooms.models import Ok

COOKIE = "df_session"
COOKIE_MAX_AGE = store.SESSION_MS // 1000


def require_csrf_header(request: Request) -> None:
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-df") != "1":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing the X-DF: 1 header.")


router = APIRouter(tags=["accounts"], dependencies=[Depends(require_csrf_header)])

AccountId = Annotated[str, Path(pattern=ACCOUNT_ID_PATTERN)]


def _now() -> int:
    return time.time_ns() // 1_000_000


def _token(request: Request) -> str | None:
    return request.cookies.get(COOKIE)


def _set_session(request: Request, response: Response, token: str) -> None:
    https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").split(",")[0] == "https"
    response.set_cookie(
        COOKIE, token, max_age=COOKIE_MAX_AGE, path="/", httponly=True, samesite="lax", secure=https
    )


@router.post("/session")
def start_session(request: Request, response: Response) -> Me:
    me, token = store.start_session(_token(request), client_ip(request), _now())
    _set_session(request, response, token)
    return me


@router.post("/account/claim")
def claim(body: Credentials, request: Request, response: Response) -> Me:
    me, token = store.claim(_token(request), body.username, body.password, _now())
    _set_session(request, response, token)
    return me


@router.post("/login")
def login(body: Credentials, request: Request, response: Response) -> Me:
    me, token = store.login(_token(request), body.username, body.password, client_ip(request), _now())
    _set_session(request, response, token)
    return me


@router.post("/logout")
def logout(request: Request, response: Response) -> Me:
    me, token = store.logout(_token(request), client_ip(request), _now())
    _set_session(request, response, token)
    return me


@router.get("/me")
def get_me(request: Request) -> Me:
    return store.get_me(_token(request), _now())


@router.patch("/me")
def update_me(body: ProfilePatch, request: Request) -> Me:
    return store.update_profile(_token(request), body, _now())


@router.post("/me/heartbeat")
def heartbeat(request: Request) -> Ok:
    store.heartbeat(_token(request), _now())
    return Ok()


@router.get("/friends")
def list_friends(request: Request) -> list[Friend]:
    return store.list_friends(_token(request), _now())


@router.post("/friends")
def add_friend(body: FriendCodeBody, request: Request) -> Friend:
    return store.add_friend(_token(request), body.code, _now())


@router.delete("/friends/{friend_id}")
def remove_friend(friend_id: AccountId, request: Request) -> Ok:
    store.remove_friend(_token(request), friend_id, _now())
    return Ok()


@router.post("/friends/{friend_id}/invite")
def invite(friend_id: AccountId, body: RoomCodeBody, request: Request) -> Ok:
    store.invite(_token(request), friend_id, body.roomCode, _now())
    return Ok()


@router.get("/me/invites")
def list_invites(request: Request) -> list[Invite]:
    return store.list_invites(_token(request), _now())


@router.post("/me/invites/{invite_id}/dismiss")
def dismiss_invite(invite_id: Annotated[int, Path(ge=1)], request: Request) -> Ok:
    store.dismiss_invite(_token(request), invite_id, _now())
    return Ok()


@router.post("/me/rooms")
def record_room(body: RoomRecordBody, request: Request) -> Ok:
    store.record_room(_token(request), body.roomCode, body.playerToken, _now())
    return Ok()


@router.get("/me/partners")
def list_partners(request: Request) -> list[Partner]:
    return store.list_partners(_token(request), _now())


@router.post("/me/rounds")
def record_round(body: RoundBody, request: Request) -> Ok:
    store.record_round(_token(request), body, _now())
    return Ok()


@router.get("/me/history")
def history(request: Request, tz_offset: Annotated[int, Query(alias="tzOffset", ge=-840, le=840)] = 0) -> History:
    return store.history(_token(request), tz_offset, _now())
