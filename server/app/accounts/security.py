"""Secrets: session tokens (stored as sha256), scrypt password hashes, friend codes."""

from __future__ import annotations

import hashlib
import hmac
import secrets

# scrypt cost: 16 MiB and ~50 ms per hash. Stored with the hash, so raising it later keeps old hashes valid.
_N, _R, _P, _DKLEN = 2**14, 8, 1, 32
FRIEND_CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no I, L, O, 0, 1
FRIEND_CODE_LEN = 6


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_friend_code() -> str:
    return "".join(secrets.choice(FRIEND_CODE_LETTERS) for _ in range(FRIEND_CODE_LEN))


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=dklen, maxmem=64 * 1024 * 1024)


def hash_password(password: str) -> str:
    """``scrypt$n$r$p$salt$hash`` (hex), with a fresh 16-byte salt per call."""
    salt = secrets.token_bytes(16)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${_scrypt(password, salt, _N, _R, _P, _DKLEN).hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time check. ``stored=None`` (no such user) still costs one hash, so it isn't faster."""
    if not stored:
        hash_password(password)
        return False
    _, n, r, p, salt, want = stored.split("$")
    got = _scrypt(password, bytes.fromhex(salt), int(n), int(r), int(p), len(want) // 2)
    return hmac.compare_digest(got, bytes.fromhex(want))
