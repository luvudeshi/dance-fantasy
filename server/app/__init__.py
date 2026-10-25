"""Midnight Ball server."""

import os
import tempfile

__version__ = "0.0.1"

# On Vercel the code directory is read-only, and librosa's numba functions (cache=True) fail at
# import without a writable cache dir. This runs before any submodule imports librosa.
if os.environ.get("VERCEL"):
    os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(tempfile.gettempdir(), "numba-cache"))
