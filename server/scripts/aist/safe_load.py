"""Load AIST++ keypoint pickles without executing arbitrary code.

The release ships ``.pkl`` files. ``pickle.load`` on an untrusted file can call any importable function,
so we use an Unpickler whose ``find_class`` only hands out the handful of numpy callables needed to rebuild
plain arrays (``_reconstruct``, ``ndarray``, ``dtype``, ``scalar``) and rejects every other global.
"""

from __future__ import annotations

import io
import pickle
import re
from pathlib import Path
from typing import Any

import numpy as np

MAX_BYTES = 64 * 1024 * 1024  # the largest AIST++ keypoint file is a few MB
NAME_RE = re.compile(
    r"^(?P<seq>g(?P<genre>[A-Z]{2})_s(?P<sit>[A-Z]{2})_c(?P<cam>\w+?)_d(?P<dancer>\d+)_m(?P<mgenre>[A-Z]{2})(?P<music>\d)_ch(?P<ch>\d+))$"
)


def _multiarray() -> Any:
    try:
        from numpy._core import multiarray  # numpy >= 2
    except ImportError:  # pragma: no cover - numpy 1.x
        from numpy.core import multiarray  # type: ignore[no-redef]
    return multiarray


_MA = _multiarray()
# (module, name) as written in the pickle -> the object we hand back. Nothing is imported by name.
ALLOWED: dict[tuple[str, str], Any] = {
    ("numpy.core.multiarray", "_reconstruct"): _MA._reconstruct,
    ("numpy._core.multiarray", "_reconstruct"): _MA._reconstruct,
    ("numpy.core.multiarray", "scalar"): _MA.scalar,
    ("numpy._core.multiarray", "scalar"): _MA.scalar,
    ("numpy", "ndarray"): np.ndarray,
    ("numpy", "dtype"): np.dtype,
}


class UnsafePickleError(pickle.UnpicklingError):
    """The pickle references something other than numpy array reconstruction."""


class RestrictedUnpickler(pickle.Unpickler):
    def find_class(self, module: str, name: str) -> Any:
        try:
            return ALLOWED[(module, name)]
        except KeyError:
            raise UnsafePickleError(f"forbidden global in pickle: {module}.{name}") from None

    def persistent_load(self, pid: Any) -> Any:
        raise UnsafePickleError("persistent ids are not allowed")


def safe_loads(data: bytes) -> Any:
    return RestrictedUnpickler(io.BytesIO(data)).load()


def _check_array(value: Any, key: str) -> np.ndarray:
    if not isinstance(value, np.ndarray) or value.dtype.kind != "f" or value.ndim != 3 or value.shape[1:] != (17, 3):
        raise ValueError(f"{key}: expected a float (N, 17, 3) array, got {type(value).__name__} {getattr(value, 'shape', '')}")
    return value.astype(np.float64, copy=False)


def load_keypoints(path: Path) -> np.ndarray:
    """(N, 17, 3) world keypoints in cm (y up, COCO-17 order) from an AIST++ keypoints3d pickle."""
    size = path.stat().st_size
    if size > MAX_BYTES:
        raise ValueError(f"{path.name}: {size} bytes is larger than expected")
    doc = safe_loads(path.read_bytes())
    if not isinstance(doc, dict):
        raise ValueError(f"{path.name}: expected a dict, got {type(doc).__name__}")
    key = "keypoints3d_optim" if "keypoints3d_optim" in doc else "keypoints3d"
    if key not in doc:
        raise ValueError(f"{path.name}: no keypoints3d array")
    return _check_array(doc[key], key)


def parse_name(stem: str) -> dict[str, str]:
    """Sequence-name fields: seq, genre, sit (BM basic / FM advanced), cam, dancer, mgenre, music (0-5), ch."""
    m = NAME_RE.match(stem)
    if not m:
        raise ValueError(f"not an AIST++ sequence name: {stem!r}")
    return m.groupdict()
