"""Badges on the player's dance card (shared/README.md, "Badges endpoints").

Every rule is a threshold on one number computed from tables we already keep (df_rounds, df_friends,
df_room_members, df_accounts), so a badge can only be earned by playing. ``evaluate_badges`` runs inside the
caller's transaction, awards whatever is newly earned and returns just those (the "Badge unlocked!" toasts);
the primary key on df_badges keeps awards idempotent across concurrent requests.
"""

from __future__ import annotations

from typing import Literal, NamedTuple

from pydantic import BaseModel

from app.rooms.db import Tx

Tier = Literal["bronze", "silver", "gold"]
DAY_MS, HOUR_MS = 86_400_000, 3_600_000
# ponytail: one fixed zone (UTC-6, Central); per-player zones would need the browser's offset stored per round.
MIDNIGHT_SHIFT_MS = -6 * HOUR_MS
MIDNIGHT_END_MS = 4 * HOUR_MS  # 00:00 to 04:00 local


class Badge(BaseModel):
    id: str
    name: str
    description: str
    icon: str  # a sticker in web/public/art/icons/
    tier: Tier
    unit: str  # what the progress counts, as in "3 / 5 songs"


class EarnedBadge(Badge):
    earnedAt: int


class Progress(BaseModel):
    have: int
    need: int


class LockedBadge(Badge):
    progress: Progress


class MyBadges(BaseModel):
    earned: list[EarnedBadge]  # catalog order: bronze, silver, gold
    locked: list[LockedBadge]


class RoundRecorded(BaseModel):
    ok: Literal[True] = True
    newBadges: list[EarnedBadge]


class Rule(NamedTuple):
    badge: Badge
    stat: str  # a key of _stats()
    need: int


def _rule(id: str, name: str, description: str, icon: str, tier: Tier, stat: str, need: int, unit: str) -> Rule:
    return Rule(Badge(id=id, name=name, description=description, icon=icon, tier=tier, unit=unit), stat, need)


CATALOG: tuple[Rule, ...] = (
    _rule("first-dance", "First Dance", "Dance your very first round.", "dance-shoe", "bronze", "rounds", 1, "rounds"),
    _rule("key-to-the-kingdom", "Key to the Kingdom", "Claim a username so your dance card follows you.", "key", "bronze", "claimed", 1, "username"),
    _rule("faithful-friend", "A Faithful Friend", "Add your first friend by their code.", "frog-prince", "bronze", "friends", 1, "friends"),
    _rule("spark-of-magic", "Spark of Magic", "Reach a 10-move combo.", "sparkles", "bronze", "combo", 10, "combo"),
    _rule("party-starter", "Party Starter", "Dance a party round with the whole court.", "party", "bronze", "party", 1, "party rounds"),
    _rule("ballroom-debut", "Ballroom Debut", "Dance a round in an online room.", "castle", "bronze", "room_rounds", 1, "room rounds"),
    _rule("songbird", "Songbird", "Dance to 5 different songs.", "music-note", "silver", "songs", 5, "songs"),
    _rule("enchanted-streak", "Enchanted Streak", "Reach a 25-move combo.", "wand", "silver", "combo", 25, "combo"),
    _rule("twelve-princesses", "Twelve Dancing Princesses", "Dance 12 rounds, one for each princess.", "slipper", "silver", "rounds", 12, "rounds"),
    _rule("royal-court", "The Royal Court", "Befriend 3 dancers.", "crown", "silver", "friends", 3, "friends"),
    _rule("belle-of-the-ball", "Belle of the Ball", "Dance in 3 different online rooms.", "lantern", "silver", "rooms", 3, "rooms"),
    _rule("stroke-of-midnight", "Stroke of Midnight", "Dance a round between midnight and 4 a.m. (Central).", "clock-tower", "silver", "midnight", 1, "midnight rounds"),
    _rule("storybook-repertoire", "A Storybook Repertoire", "Dance to 10 different songs.", "storybook", "gold", "songs", 10, "songs"),
    _rule("golden-goose", "The Golden Goose", "Reach a 50-move combo.", "golden-egg", "gold", "combo", 50, "combo"),
    _rule("hundred-year-spell", "The Hundred-Year Spell", "Reach a 100-move combo.", "spindle", "gold", "combo", 100, "combo"),
    _rule("fairest-of-them-all", "Fairest of Them All", "Earn 5 stars or 98% accuracy in one round.", "mirror", "gold", "perfect", 1, "perfect rounds"),
)  # fmt: skip


def _count(tx: Tx, sql: str, account_id: str) -> int:
    row = tx.one(sql, me=account_id)
    return int(row["n"]) if row else 0


def _stats(tx: Tx, account_id: str) -> dict[str, int]:
    r = tx.one(
        "select count(*) as rounds, count(distinct analysis_id) as songs, max(max_combo) as combo,"
        " sum(case when stars >= 5 or accuracy >= 98 then 1 else 0 end) as perfect,"
        " sum(case when mode = 'party' then 1 else 0 end) as party,"
        " sum(case when mode = 'room' then 1 else 0 end) as room_rounds,"
        " sum(case when (at + :shift) - ((at + :shift) / :day) * :day < :end then 1 else 0 end) as midnight"
        " from df_rounds where account_id = :me",
        me=account_id, shift=MIDNIGHT_SHIFT_MS, day=DAY_MS, end=MIDNIGHT_END_MS,
    ) or {}  # fmt: skip
    stats = {k: int(v or 0) for k, v in r.items()}
    stats["friends"] = _count(tx, "select count(*) as n from df_friends where account_id = :me", account_id)
    stats["rooms"] = _count(tx, "select count(*) as n from df_room_members where account_id = :me", account_id)
    stats["claimed"] = _count(tx, "select count(*) as n from df_accounts where id = :me and username is not null", account_id)
    return stats


def _earned(tx: Tx, account_id: str) -> dict[str, int]:
    rows = tx.all("select badge_id, earned_at from df_badges where account_id = :me", me=account_id)
    return {r["badge_id"]: int(r["earned_at"]) for r in rows}


def evaluate_badges(tx: Tx, account_id: str, now: int) -> list[EarnedBadge]:
    """Award every badge the account now qualifies for; returns only the newly earned ones."""
    stats, have = _stats(tx, account_id), _earned(tx, account_id)
    new: list[EarnedBadge] = []
    for rule in CATALOG:
        if rule.badge.id in have or stats[rule.stat] < rule.need:
            continue
        inserted = tx.run(
            "insert into df_badges (account_id, badge_id, earned_at) values (:me, :b, :now) on conflict do nothing",
            me=account_id, b=rule.badge.id, now=now,
        )  # fmt: skip
        if inserted == 1:  # 0: a concurrent request awarded it first
            new.append(EarnedBadge(**rule.badge.model_dump(), earnedAt=now))
    return new


def my_badges(tx: Tx, account_id: str, now: int) -> MyBadges:
    evaluate_badges(tx, account_id, now)  # catches badges earned by someone else's action (a friend adding you)
    stats, have = _stats(tx, account_id), _earned(tx, account_id)
    return MyBadges(
        earned=[EarnedBadge(**r.badge.model_dump(), earnedAt=have[r.badge.id]) for r in CATALOG if r.badge.id in have],
        locked=[
            LockedBadge(**r.badge.model_dump(), progress=Progress(have=min(stats[r.stat], r.need), need=r.need))
            for r in CATALOG
            if r.badge.id not in have
        ],
    )
