"""Global-layer storage: safe serialization + SQLite-backed object store.

Serialization formats (the BLOB column stores the raw payload; the
`format` column describes how to decode it):

  json     - JSON with type tags; base for plain types (str/int/float/
             bool/None/list/dict/bytes/datetime + numpy scalars)
  npy      - numpy arrays via np.save (numpy required)
  parquet  - pandas/polars DataFrame/Series via pyarrow (optional dep)
  raw      - plain bytes passed through

Safety (see RULES.md): only whitelisted types can be published. No
pickle, no cloudpickle, no arbitrary code execution channel.

Concurrency (see RULES.md): SQLite IS the lock. WAL journaling gives
readers/writers without blocking, transactions give atomicity, and the
busy timeout serializes concurrent writers. No hand-written file locks.

The store lives at <workspace>/.kernel/store.sqlite. It is the single
shared point across sessions of the same workspace; every read goes
straight to SQLite so data is always fresh after any commit.
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import json
import os
import re
import sqlite3
import uuid
from typing import Any

# Single-object size limit (RULES.md): larger payloads are rejected.
MAX_BLOB_SIZE = 256 * 1024 * 1024

# Object names: letters/digits/_/-/., must not start with an underscore
# (consistent with the namespace-diff privacy convention).
_NAME_RE = re.compile(r"[A-Za-z0-9_.\-]+$")

# Optional heavy dependencies (used when available; see serialize()).
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


class PublishError(ValueError):
    """Raised when an object cannot be published (type, size, name...)."""


class ConflictError(PublishError):
    """Raised on expected_version mismatch."""


# ---------------------------------------------------------------------------
# Type whitelist and canonical names


def check_type(obj: Any) -> str:
    """Return the canonical type name, or raise PublishError.

    Order matters: bool subclasses int; numpy scalars are not native.
    """
    if obj is None:
        return "None"
    if isinstance(obj, bool):
        return "bool"
    if _NUMPY is not None:
        if isinstance(obj, _NUMPY.ndarray):
            return "ndarray"
        if isinstance(obj, _NUMPY.generic):
            return "numpy_scalar"
    if isinstance(obj, (int, float, str)):
        return type(obj).__name__
    if isinstance(obj, bytes):
        return "bytes"
    if isinstance(obj, datetime.datetime):
        return "datetime"
    if _NUMPY is not None:
        if isinstance(obj, _NUMPY.ndarray):
            return "ndarray"
        if isinstance(obj, _NUMPY.generic):
            return "numpy_scalar"
    if _PANDAS is not None:
        if isinstance(obj, _PANDAS.DataFrame):
            return "DataFrame"
        if isinstance(obj, _PANDAS.Series):
            return "Series"
    if _POLARS is not None:
        if isinstance(obj, _POLARS.DataFrame):
            return "DataFrame"
        if isinstance(obj, _POLARS.Series):
            return "Series"
    if isinstance(obj, (list, dict)):
        return type(obj).__name__
    raise PublishError(
        f"type {type(obj).__name__} is not publishable; supported: "
        "str/int/float/bool/None/bytes/datetime/list/dict/numpy scalars and "
        "arrays/pandas and polars DataFrame and Series. For other objects, "
        "export to a file instead."
    )


# ---------------------------------------------------------------------------
# JSON codec with type tags (recursive; the base format)


def _encode_json(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, bytes):
        return {"__type__": "bytes", "data": base64.b64encode(v).decode("ascii")}
    if isinstance(v, datetime.datetime):
        return {"__type__": "datetime", "value": v.isoformat()}
    if _NUMPY is not None and isinstance(v, _NUMPY.generic):
        return {"__type__": "numpy_scalar", "kind": v.dtype.kind, "value": v.item()}
    if isinstance(v, list):
        return [_encode_json(x) for x in v]
    if isinstance(v, dict):
        for k in v:
            if not isinstance(k, str):
                raise PublishError(f"dict keys must be str (found {type(k).__name__} key)")
        return {k: _encode_json(x) for k, x in v.items()}
    raise PublishError(f"cannot JSON-encode {type(v).__name__} nested value")


def _decode_json(v: Any) -> Any:
    if isinstance(v, dict) and "__type__" in v:
        tag = v["__type__"]
        if tag == "bytes":
            return base64.b64decode(v["data"])
        if tag == "datetime":
            return datetime.datetime.fromisoformat(v["value"])
        if tag == "numpy_scalar":
            if _NUMPY is None:
                raise PublishError("numpy is not installed; cannot restore numpy scalar")
            kind = v["kind"]
            if kind == "f":
                return float(v["value"])
            if kind == "b":
                return bool(v["value"])
            return int(v["value"])
        return v
    if isinstance(v, list):
        return [_decode_json(x) for x in v]
    if isinstance(v, dict):
        return {k: _decode_json(x) for k, x in v.items()}
    return v


# ---------------------------------------------------------------------------
# Public serialize/deserialize


def serialize(obj: Any) -> tuple[str, bytes]:
    """Serialize a whitelisted object -> (format, blob)."""
    typename = check_type(obj)
    if typename in ("str", "int", "float", "bool", "None", "datetime", "numpy_scalar", "list", "dict"):
        return "json", json.dumps(_encode_json(obj), ensure_ascii=False).encode("utf-8")
    if typename == "bytes":
        return "raw", obj
    if typename == "ndarray":
        if _NUMPY is None:
            raise PublishError("numpy is required to publish ndarray")
        import io

        buf = io.BytesIO()
        _NUMPY.save(buf, obj, allow_pickle=False)
        return "npy", buf.getvalue()
    if typename in ("DataFrame", "Series"):
        import io

        buf = io.BytesIO()
        if _PANDAS is not None and isinstance(obj, (_PANDAS.DataFrame, _PANDAS.Series)):
            try:
                if isinstance(obj, _PANDAS.Series):
                    # pandas Series has no to_parquet; store as a single-
                    # column frame, keeping the series name as the column
                    # name (None -> marker '__series__'), and unwrap in
                    # load() using the stored type.
                    frame = obj.to_frame()
                    if obj.name is None:
                        frame = frame.rename(columns={frame.columns[0]: "__series__"})
                    frame.to_parquet(buf)
                else:
                    obj.to_parquet(buf)
            except ImportError:
                raise PublishError(
                    "pyarrow is required to publish pandas objects; install it or publish a JSON-compatible form instead"
                )
            return "parquet", buf.getvalue()
        if _POLARS is not None and isinstance(obj, (_POLARS.DataFrame, _POLARS.Series)):
            if isinstance(obj, _POLARS.Series):
                obj.to_frame("__series__").write_parquet(buf)
            else:
                obj.write_parquet(buf)
            return "parquet", buf.getvalue()
        raise PublishError(f"no parquet writer for {typename}")
    raise PublishError(f"no serializer for {typename}")

def deserialize(format_name: str, blob: bytes, expected_type: str | None = None) -> Any:
    """Decode a blob. expected_type disambiguates parquet round-trips
    (Series is stored as a single-column frame; load() passes the stored
    type so a user's single-column DataFrame is never mis-unwrapped)."""
    if format_name == "json":
        return _decode_json(json.loads(blob.decode("utf-8")))
    if format_name == "raw":
        return blob
    if format_name == "npy":
        if _NUMPY is None:
            raise PublishError("numpy is not installed; cannot restore ndarray")
        import io

        return _NUMPY.load(io.BytesIO(blob), allow_pickle=False)
    if format_name == "parquet":
        import io

        if _PANDAS is not None:
            frame = _PANDAS.read_parquet(io.BytesIO(blob))
            if expected_type == "Series":
                col = frame.columns[0]
                return frame.iloc[:, 0].rename(None if col == "__series__" else col)
            if list(frame.columns) == ["__series__"]:
                return frame["__series__"]
            return frame
        if _POLARS is not None:
            frame = _POLARS.read_parquet(io.BytesIO(blob))
            if expected_type == "Series":
                return frame.to_series()
            if frame.columns == ["__series__"]:
                return frame["__series__"]
            return frame
        raise PublishError("pandas/polars with pyarrow is required to restore parquet objects")
    raise PublishError(f"unknown format {format_name!r}")


# ---------------------------------------------------------------------------
# SQLite store


class GlobalStore:
    """The workspace-global object store: one SQLite database, WAL mode.

    All reads go directly to SQLite (always fresh); all writes happen in
    a single transaction (data + metadata committed atomically).
    """

    def __init__(self, workspace: str):
        self.dir = os.path.join(workspace, ".kernel")
        os.makedirs(self.dir, exist_ok=True)
        self.db_path = os.path.join(self.dir, "store.sqlite")
        self.conn = sqlite3.connect(self.db_path, timeout=10)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS objects (
                name        TEXT PRIMARY KEY,
                format      TEXT NOT NULL,
                type        TEXT NOT NULL,
                blob        BLOB NOT NULL,
                size        INTEGER NOT NULL,
                version     INTEGER NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                source_path TEXT,
                source_hash TEXT,
                created_at  TEXT NOT NULL
            )"""
        )
        self.conn.commit()

    def publish(
        self,
        name: str,
        obj: Any,
        description: str = "",
        source: str | None = None,
        expected_version: int | None = None,
    ) -> dict:
        """Store an object in the global layer.

        Semantics (RULES.md): same-name publish = last-write-wins with an
        `overwritten` flag in the result; pass expected_version for an
        optimistic lock (mismatch raises ConflictError).
        """
        if not _NAME_RE.match(name) or name.startswith("_"):
            raise PublishError(f"invalid object name {name!r}: use letters/digits/._- and do not start with '_'")
        if not isinstance(description, str) or not description.strip():
            raise PublishError("a non-empty description is required when publishing")
        format_name, blob = serialize(obj)
        if len(blob) > MAX_BLOB_SIZE:
            raise PublishError(
                f"object too large: {len(blob) / 1024 / 1024:.1f} MB exceeds the {MAX_BLOB_SIZE / 1024 / 1024:.0f} MB limit"
            )
        source_hash = None
        if source:
            if not os.path.isfile(source):
                raise PublishError(f"source file not found: {source}")
            source_hash = _file_sha256(source)
        created_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self.conn:
            row = self.conn.execute("SELECT version FROM objects WHERE name = ?", (name,)).fetchone()
            if expected_version is not None:
                current = row[0] if row else 0
                if current != expected_version:
                    raise ConflictError(
                        f"version conflict: expected {expected_version}, current {current} (re-read with ls/get first)"
                    )
            version = (row[0] + 1) if row else 1
            self.conn.execute(
                """INSERT INTO objects (name, format, type, blob, size, version, description, source_path, source_hash, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(name) DO UPDATE SET
                       format=excluded.format, type=excluded.type, blob=excluded.blob,
                       size=excluded.size, version=excluded.version, description=excluded.description,
                       source_path=excluded.source_path, source_hash=excluded.source_hash,
                       created_at=excluded.created_at""",
                (name, format_name, check_type(obj), sqlite3.Binary(blob), len(blob), version, description, source, source_hash, created_at),
            )
        return {"version": version, "overwritten": row is not None}
    def delete(self, name: str, expected_version: int | None = None) -> dict:
        """Delete a global-layer object. Idempotent: deleting a missing
        object returns deleted=False instead of raising. Pass
        expected_version for an optimistic lock (mismatch raises
        ConflictError). The row is removed entirely, so a later publish
        of the same name starts at version 1 again.
        """
        if not _NAME_RE.match(name) or name.startswith("_"):
            raise PublishError(
                f"invalid object name {name!r}: use letters/digits/._- and do not start with '_'"
            )
        with self.conn:
            row = self.conn.execute(
                "SELECT version FROM objects WHERE name = ?", (name,)
            ).fetchone()
            if row is None:
                return {"deleted": False, "version": None}
            version = row[0]
            if expected_version is not None and version != expected_version:
                raise ConflictError(
                    f"version conflict: expected {expected_version}, current {version} (re-read with ls first)"
                )
            self.conn.execute("DELETE FROM objects WHERE name = ?", (name,))
        return {"deleted": True, "version": version}

    def list_objects(self, pattern: str | None = None) -> list[dict]:
        rows = self.conn.execute(
            "SELECT name, type, size, version, description, source_path, source_hash, created_at FROM objects"
        ).fetchall()
        out = []
        for name, typename, size, version, description, source_path, source_hash, created_at in rows:
            if pattern and not _match(pattern, name):
                continue
            valid, reason = self.validate(name, source_path, source_hash)
            out.append(
                {
                    "name": name,
                    "type": typename,
                    "size": size,
                    "version": version,
                    "description": description,
                    "created_at": created_at,
                    "valid": valid,
                    "invalid_reason": reason,
                    "source_path": source_path,
                }
            )
        return sorted(out, key=lambda o: o["name"])

    def get_meta(self, name: str) -> dict | None:
        row = self.conn.execute(
            "SELECT name, format, type, size, version, description, source_path, source_hash, created_at FROM objects WHERE name = ?",
            (name,),
        ).fetchone()
        if row is None:
            return None
        name_, format_, typename, size, version, description, source_path, source_hash, created_at = row
        valid, reason = self.validate(name_, source_path, source_hash)
        return {
            "name": name_,
            "format": format_,
            "type": typename,
            "size": size,
            "version": version,
            "description": description,
            "created_at": created_at,
            "valid": valid,
            "invalid_reason": reason,
            "source_path": source_path,
        }

    def load(self, name: str, force: bool = False) -> tuple[dict, Any]:
        """Load object + meta. Raises KeyError if missing; PublishError if
        stale unless force=True (explicit retrieval of old data)."""
        meta = self.get_meta(name)
        if meta is None:
            raise KeyError(f"no global object named {name!r}")
        if not meta["valid"] and not force:
            raise PublishError(f"object {name!r} is stale: {meta['invalid_reason']}")
        row = self.conn.execute("SELECT blob FROM objects WHERE name = ?", (name,)).fetchone()
        obj = deserialize(meta["format"], row[0], meta["type"])
        return meta, obj

    def validate(self, name: str, source_path: str | None, source_hash: str | None) -> tuple[bool, str | None]:
        """Snapshot staleness check: source file hash must match."""
        if not source_path:
            return True, None
        if not os.path.exists(source_path):
            return False, f"source file missing: {source_path}"
        if _file_sha256(source_path) != source_hash:
            return False, f"source file changed since publish ({source_path}); rebuild and re-publish"
        return True, None


def _file_sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _match(pattern: str, name: str) -> bool:
    import fnmatch

    return fnmatch.fnmatchcase(name, pattern)


def make_blob_id() -> str:
    """Unique id for a blob (used by sessions; kept here for symmetry)."""
    return uuid.uuid4().hex
