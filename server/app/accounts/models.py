"""Request and response bodies for the accounts API (shared/README.md, "Accounts endpoints").

Request models forbid unknown fields. Display names follow the rooms rules (1-24 chars, whitespace
collapsed, no control characters). Avatars and colours come from fixed allowlists that match the
web design system (web/src/theme/icons.ts and the --df-* colour tokens).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field

from app.analysis_store import ID_RE
from app.rooms.models import Name, _clean
from app.accounts.security import FRIEND_CODE_LEN, FRIEND_CODE_LETTERS

# Same order as ICON_NAMES in web/src/theme/icons.ts: 28 fairy-tale stickers, then the Dance Fantasy ones.
AVATARS = (
    "apple", "beanstalk", "castle", "clock-tower", "cottage", "cracked-mirror", "crown", "crystal-ball", "eat-me",
    "frog-prince", "golden-egg", "key", "lamp", "lantern", "map", "mirror", "potion", "pumpkin", "quill", "red-hood",
    "scroll", "slipper", "sparkles", "spindle", "storybook", "tree", "wand", "wolf",
    "music-note", "dance-shoe", "trophy", "mirror-cam", "gear", "play", "pause", "party", "chat", "upload",
)  # fmt: skip
GUEST_AVATARS = AVATARS[:28]  # new guests get a random fairy-tale sticker
COLORS = ("rasp", "gold", "blue", "sage", "burg", "night")  # --df-<color> tokens
USERNAME_PATTERN = r"^[a-z0-9_]{3,20}$"
FRIEND_CODE_PATTERN = f"^[{FRIEND_CODE_LETTERS}]{{{FRIEND_CODE_LEN}}}$"
ACCOUNT_ID_PATTERN = r"^[A-Za-z0-9_-]{1,32}$"
RoundMode = Literal["solo", "party", "room"]


def _one_of(allowed: tuple[str, ...], what: str) -> Callable[[str], str]:
    def check(value: str) -> str:
        if value not in allowed:
            raise ValueError(f"unknown {what}")
        return value

    return check


def _lower(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


def _friend_code(value: object) -> object:
    """Forgiving about how people type a code: case, spaces and dashes don't matter."""
    return value.upper().replace(" ", "").replace("-", "") if isinstance(value, str) else value


Avatar = Annotated[str, AfterValidator(_one_of(AVATARS, "avatar"))]
Color = Annotated[str, AfterValidator(_one_of(COLORS, "color"))]
Username = Annotated[str, BeforeValidator(_lower), Field(pattern=USERNAME_PATTERN)]
Password = Annotated[str, Field(min_length=8, max_length=200)]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Credentials(_Request):
    username: Username
    password: Password


class ProfilePatch(_Request):
    name: Name | None = None
    avatar: Avatar | None = None
    color: Color | None = None


class FriendCodeBody(_Request):
    code: Annotated[str, BeforeValidator(_friend_code), Field(pattern=FRIEND_CODE_PATTERN)]


class RoomCodeBody(_Request):
    roomCode: str = Field(min_length=1, max_length=8)


class RoomRecordBody(RoomCodeBody):
    playerToken: str = Field(min_length=1, max_length=200)


class RoundBody(_Request):
    analysisId: str = Field(pattern=ID_RE.pattern)
    songTitle: Annotated[str, BeforeValidator(_clean), Field(min_length=1, max_length=200)]
    score: int = Field(ge=0, le=100_000_000)
    accuracy: float = Field(ge=0, le=100)  # percent, like the results screen
    maxCombo: int = Field(ge=0, le=100_000)
    stars: int = Field(ge=0, le=5)
    mode: RoundMode


class Stats(BaseModel):
    rounds: int
    bestScore: int
    friends: int


class Me(BaseModel):
    id: str
    name: str
    avatar: str
    color: str
    friendCode: str
    isGuest: bool
    username: str | None
    stats: Stats


class Friend(BaseModel):
    id: str
    name: str
    avatar: str
    color: str
    online: bool
    inRoom: str | None  # room code while they are connected to a room they recorded


class Partner(BaseModel):
    id: str
    name: str
    avatar: str
    color: str
    friendCode: str
    online: bool
    isFriend: bool
    lastPlayedAt: int


class Invite(BaseModel):
    id: int
    fromId: str
    fromName: str
    fromAvatar: str
    fromColor: str
    roomCode: str
    at: int


class Round(BaseModel):
    analysisId: str
    songTitle: str
    score: int
    accuracy: float
    maxCombo: int
    stars: int
    mode: str
    at: int


class History(BaseModel):
    rounds: list[Round]  # newest first, at most 20
    totalRounds: int
    bestScore: int
    avgAccuracy: float
    dayStreak: int
