"""On-disk cache of generated routines: ``<cache_dir>/routines/<routineId>.json``.

Stored as the exact bytes served, so a cache hit returns byte-identical JSON. Writes are atomic
(temp file + ``os.replace``, see app.analysis_store). Blocking I/O: call from a worker thread.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from app.analysis_store import _atomic_write

log = logging.getLogger(__name__)

ROUTINE_ID_PATTERN = r"^[0-9a-f]{16}$"
_ROUTINE_ID_RE = re.compile(ROUTINE_ID_PATTERN)


class RoutineStore:
    def __init__(self, cache_dir: Path) -> None:
        self.dir = cache_dir / "routines"

    def path(self, routine_id: str) -> Path:
        if not _ROUTINE_ID_RE.match(routine_id):
            raise ValueError("routine id must be 16 lowercase hex characters")
        return self.dir / f"{routine_id}.json"

    def load_bytes(self, routine_id: str) -> bytes | None:
        """The cached routine JSON, or None if missing or unreadable (it is then regenerated)."""
        path = self.path(routine_id)
        try:
            data = path.read_bytes()
            if not isinstance(json.loads(data), dict):
                raise ValueError("not a JSON object")
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            log.warning("ignoring unreadable routine cache %s: %s", path.name, exc)
            return None
        return data

    def save_bytes(self, routine_id: str, data: bytes) -> None:
        _atomic_write(self.path(routine_id), data)
