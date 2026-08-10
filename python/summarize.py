"""Object summarization for kernel_get: compact, structure-aware previews.

The summaries are the agent's primary way of seeing what an object is
without pulling its full contents into context. Every summary is
bounded (see MAX_SUMMARY) so the tool result stays small.
"""

from __future__ import annotations

from typing import Any

MAX_SUMMARY = 4_000
MAX_FULL = 200_000

# Optional deps (same pattern as storage.py).
_PANDAS = None
_NUMPY = None
_POLARS = None

try:
    import numpy as _NUMPY_MOD

    _NUMPY = _NUMPY_MOD
except ImportError:  # pragma: no cover - environment dependent
    pass
try:
    import pandas as _PANDAS_MOD

    _PANDAS = _PANDAS_MOD
except ImportError:  # pragma: no cover - environment dependent
    pass
try:
    import polars as _POLARS_MOD

    _POLARS = _POLARS_MOD
except ImportError:  # pragma: no cover - environment dependent
    pass


def summarize(obj: Any, max_chars: int = MAX_SUMMARY) -> str:
    """Return a compact structural summary of obj."""
    if obj is None:
        return "None"
    if isinstance(obj, bool):
        return repr(obj)
    if isinstance(obj, (int, float, str)):
        return _truncate(repr(obj), max_chars)
    if isinstance(obj, bytes):
        head = obj[:16].hex(" ")
        return f"bytes len={len(obj)} head=[{head}]{'...' if len(obj) > 16 else ''}"
    if _PANDAS is not None and isinstance(obj, _PANDAS.DataFrame):
        return _pandas_df_summary(obj, max_chars)
    if _PANDAS is not None and isinstance(obj, _PANDAS.Series):
        return _pandas_series_summary(obj, max_chars)
    if _POLARS is not None and isinstance(obj, _POLARS.DataFrame):
        return _polars_df_summary(obj, max_chars)
    if _POLARS is not None and isinstance(obj, _POLARS.Series):
        return _polars_series_summary(obj, max_chars)
    if _NUMPY is not None and isinstance(obj, _NUMPY.ndarray):
        return f"ndarray shape={obj.shape} dtype={obj.dtype} " + _truncate(repr(obj)[:300], max_chars)
    if isinstance(obj, dict):
        return _dict_summary(obj, max_chars)
    if isinstance(obj, (list, tuple)):
        return _list_summary(obj, max_chars)
    return _truncate(repr(obj), max_chars)


def full_text(obj: Any, max_chars: int = MAX_FULL) -> str:
    """Best-effort full textual rendering (truncated to max_chars)."""
    try:
        text = str(obj)
    except Exception:  # noqa: BLE001 - never fail the tool over repr
        text = repr(obj)
    return _truncate(text, max_chars)


def _dict_summary(obj: dict, max_chars: int) -> str:
    lines = [f"dict len={len(obj)}"]
    for k in list(obj.keys())[:10]:
        v = obj[k]
        lines.append(f"  {k!r}: {type(v).__name__} = {_truncate(repr(v)[:80], 200)}")
    if len(obj) > 10:
        lines.append(f"  ... and {len(obj) - 10} more keys")
    return _truncate("\n".join(lines), max_chars)


def _list_summary(obj: list, max_chars: int) -> str:
    preview = ", ".join(_truncate(repr(x), 60) for x in obj[:5])
    types = {type(x).__name__ for x in obj}
    extra = f"; types={sorted(types)}" if len(types) > 1 else ""
    tail = f", ..." if len(obj) > 5 else ""
    return _truncate(f"list len={len(obj)} [{preview}{tail}]{extra}", max_chars)


def _pandas_df_summary(obj, max_chars: int) -> str:
    lines = [
        f"DataFrame shape={obj.shape}",
        f"columns: {list(obj.columns)}",
        "dtypes: " + ", ".join(f"{c}={str(t)}" for c, t in zip(obj.columns, obj.dtypes)),
    ]
    if len(obj) > 0:
        head = obj.head(3).to_string(max_rows=3)
        lines.append("head(3):\n" + head)
    return _truncate("\n".join(lines), max_chars)


def _pandas_series_summary(obj, max_chars: int) -> str:
    lines = [f"Series name={obj.name!r} len={len(obj)} dtype={obj.dtype}"]
    if len(obj) > 0:
        lines.append("head(3): " + ", ".join(repr(x) for x in obj.head(3).tolist()))
    return _truncate("\n".join(lines), max_chars)


def _polars_df_summary(obj, max_chars: int) -> str:
    lines = [f"DataFrame shape={obj.shape}", f"columns: {obj.columns}"]
    if len(obj) > 0:
        lines.append("head(3):\n" + _truncate(str(obj.head(3)), 800))
    return _truncate("\n".join(lines), max_chars)


def _polars_series_summary(obj, max_chars: int) -> str:
    lines = [f"Series name={obj.name!r} len={len(obj)} dtype={obj.dtype}"]
    if len(obj) > 0:
        lines.append("head(3): " + _truncate(str(obj.head(3).to_list()), 300))
    return _truncate("\n".join(lines), max_chars)


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n... [truncated {len(text) - max_chars} chars]"
