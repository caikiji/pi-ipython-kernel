"""Unit tests for the global-layer storage: serialization + SQLite store."""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "python"))

import storage  # noqa: E402
from storage import GlobalStore, PublishError  # noqa: E402

HAS_NUMPY = storage._NUMPY is not None
HAS_PANDAS = storage._PANDAS is not None


class SerializeTest(unittest.TestCase):
    def roundtrip(self, obj):
        fmt, blob = storage.serialize(obj)
        return storage.deserialize(fmt, blob, storage.check_type(obj))

    def test_plain_types(self):
        for obj in [42, 3.14, True, False, None, "hello", "中文", [1, "a", None], {"k": [1, 2], "n": None}]:
            back = self.roundtrip(obj)
            self.assertEqual(type(back), type(obj), obj)
            self.assertEqual(back, obj)

    def test_bytes(self):
        back = self.roundtrip(b"\x00\x01\xff")
        self.assertEqual(back, b"\x00\x01\xff")

    def test_datetime(self):
        import datetime

        back = self.roundtrip(datetime.datetime(2026, 1, 1, 12, 30))
        self.assertEqual(back, datetime.datetime(2026, 1, 1, 12, 30))

    def test_nested_bytes_in_list(self):
        back = self.roundtrip([b"x", {"b": b"y"}])
        self.assertEqual(back, [b"x", {"b": b"y"}])

    @unittest.skipUnless(HAS_NUMPY, "numpy not installed")
    def test_numpy_scalars(self):
        import numpy as np

        for obj in [np.float64(1.5), np.int32(7), np.bool_(True)]:
            back = self.roundtrip(obj)
            self.assertEqual(back, obj)
            self.assertIsInstance(back, (int, float, bool))

    @unittest.skipUnless(HAS_NUMPY, "numpy not installed")
    def test_numpy_scalars_reject_non_roundtrippable_kinds(self):
        import numpy as np

        # datetime64 / timedelta64 / complex / string scalars cannot
        # round-trip through JSON; check_type must raise a clean
        # PublishError instead of blowing up in json.dumps later.
        for bad in [np.datetime64("2020-01-01"), np.timedelta64(5, "D"), np.complex128(1 + 2j), np.bytes_(b"abc")]:
            with self.assertRaises(PublishError):
                storage.check_type(bad)
        # uint64 with a value beyond int64 is preserved exactly
        big = np.uint64(2**63)
        fmt, blob = storage.serialize(big)
        back = storage.deserialize(fmt, blob, storage.check_type(big))
        self.assertEqual(back, 2**63)
    @unittest.skipUnless(HAS_NUMPY, "numpy not installed")
    def test_numpy_ndarray(self):
        import numpy as np

        arr = np.arange(12, dtype=np.float64).reshape(3, 4)
        back = self.roundtrip(arr)
        self.assertEqual(back.dtype, arr.dtype)
        self.assertTrue((back == arr).all())

    @unittest.skipUnless(HAS_PANDAS, "pandas not installed")
    def test_pandas_dataframe(self):
        import pandas as pd

        df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
        back = self.roundtrip(df)
        self.assertIsInstance(back, pd.DataFrame)
        self.assertTrue(back.equals(df))

    @unittest.skipUnless(HAS_PANDAS, "pandas not installed")
    def test_pandas_series_keeps_name(self):
        import pandas as pd

        s = pd.Series([1.5, 2.5], name="vals")
        back = self.roundtrip(s)
        self.assertIsInstance(back, pd.Series)
        self.assertEqual(back.name, "vals")
        self.assertTrue(back.equals(s))

    @unittest.skipUnless(HAS_PANDAS, "pandas not installed")
    def test_single_column_dataframe_not_misread_as_series(self):
        import pandas as pd

        df = pd.DataFrame({"data": [1, 2]})
        back = self.roundtrip(df)
        self.assertIsInstance(back, pd.DataFrame)
        self.assertEqual(list(back.columns), ["data"])

    def test_whitelist_rejects(self):
        for bad in [lambda: 1, (1, 2), {"a": 1}.keys(), object()]:
            with self.assertRaises(PublishError):
                storage.check_type(bad)

    def test_dict_non_str_key_rejected(self):
        with self.assertRaises(PublishError):
            storage.serialize({1: "x"})

    def test_user_dict_with_type_tag_key_survives_roundtrip(self):
        # a user dict carrying the legacy tag key must not be silently
        # reinterpreted as a tagged value on load
        obj = {"__type__": "bytes", "data": "hello", "n": 1}
        back = self.roundtrip(obj)
        self.assertEqual(back, obj)
        self.assertIsInstance(back, dict)

    def test_nested_type_tag_key_survives_roundtrip(self):
        obj = {"a": {"__type__": "datetime"}, "b": [{"__type__": "bytes"}]}
        back = self.roundtrip(obj)
        self.assertEqual(back, obj)

    def test_legacy_blobs_still_decode(self):
        # blobs written before the tag namespacing keep loading
        self.assertEqual(storage.deserialize("json", b'{"__type__": "bytes", "data": "aGk="}'), b"hi")
        import datetime

        self.assertEqual(
            storage.deserialize("json", b'{"__type__": "datetime", "value": "2026-01-01T12:30:00"}'),
            datetime.datetime(2026, 1, 1, 12, 30),
        )

    def test_namespaced_tags_roundtrip(self):
        self.assertEqual(self.roundtrip(b"\x00\x01\xff"), b"\x00\x01\xff")
        import datetime

        self.assertEqual(self.roundtrip(datetime.datetime(2026, 1, 1)), datetime.datetime(2026, 1, 1))


class GlobalStoreTest(unittest.TestCase):
    def setUp(self):
        self.wd = tempfile.mkdtemp()
        self.store = GlobalStore(self.wd)

    def tearDown(self):
        self.store.conn.close()
        import shutil

        shutil.rmtree(self.wd, ignore_errors=True)

    def test_publish_versioning_and_overwrite(self):
        self.assertEqual(self.store.publish("x", 1, description="one"), {"version": 1, "overwritten": False})
        self.assertEqual(self.store.publish("x", 2, description="two"), {"version": 2, "overwritten": True})
        meta = self.store.get_meta("x")
        self.assertEqual(meta["version"], 2)
        self.assertEqual(meta["type"], "int")

    def test_expected_version_optimistic_lock(self):
        self.store.publish("x", 1, description="one")
        with self.assertRaises(storage.ConflictError):
            self.store.publish("x", 2, description="two", expected_version=99)
        self.store.publish("x", 2, description="two", expected_version=1)
        self.assertEqual(self.store.get_meta("x")["version"], 2)

    def test_name_validation(self):
        for bad in ["_x", "a b", "", "a/b"]:
            with self.assertRaises(PublishError):
                self.store.publish(bad, 1, description="x")

    def test_description_required(self):
        with self.assertRaises(PublishError):
            self.store.publish("x", 1, description="")
        with self.assertRaises(PublishError):
            self.store.publish("x", 1, description="   ")

    def test_size_limit(self):
        old = storage.MAX_BLOB_SIZE
        storage.MAX_BLOB_SIZE = 10
        try:
            with self.assertRaises(PublishError):
                self.store.publish("big", "x" * 100, description="big")
        finally:
            storage.MAX_BLOB_SIZE = old

    def test_staleness_check(self):
        src = os.path.join(self.wd, "src.txt")
        with open(src, "w") as f:
            f.write("v1")
        self.store.publish("data", "v1-content", description="from file", source=src)
        self.assertTrue(self.store.get_meta("data")["valid"])
        with open(src, "w") as f:
            f.write("v2")
        meta = self.store.get_meta("data")
        self.assertFalse(meta["valid"])
        self.assertIn("changed", meta["invalid_reason"])

    def test_staleness_missing_source(self):
        src = os.path.join(self.wd, "gone.txt")
        with open(src, "w") as f:
            f.write("x")
        self.store.publish("data", "x", description="from file", source=src)
        os.remove(src)
        meta = self.store.get_meta("data")
        self.assertFalse(meta["valid"])
        self.assertIn("missing", meta["invalid_reason"])

    def test_source_must_exist_at_publish(self):
        with self.assertRaises(PublishError):
            self.store.publish("data", "x", description="d", source=os.path.join(self.wd, "nope.txt"))

    def test_load_and_missing(self):
        self.store.publish("x", {"a": 1}, description="d")
        meta, obj = self.store.load("x")
        self.assertEqual(obj, {"a": 1})
        self.assertEqual(meta["name"], "x")
        with self.assertRaises(KeyError):
            self.store.load("missing")

    def test_load_stale_rejected(self):
        src = os.path.join(self.wd, "src.txt")
        with open(src, "w") as f:
            f.write("v1")
        self.store.publish("data", "old", description="d", source=src)
        with open(src, "w") as f:
            f.write("v2")
        with self.assertRaises(PublishError):
            self.store.load("data")

    def test_schema_version_recorded(self):
        row = self.store.conn.execute("PRAGMA user_version").fetchone()
        self.assertEqual(row[0], storage.SCHEMA_VERSION)

    def test_newer_schema_rejected(self):
        self.store.conn.execute("PRAGMA user_version = 999")
        self.store.conn.commit()
        with self.assertRaises(RuntimeError):
            GlobalStore(self.wd)

    def test_list_objects_with_pattern(self):
        self.store.publish("df_a", 1, description="d")
        self.store.publish("df_b", 2, description="d")
        self.store.publish("cfg", 3, description="d")
        names = [o["name"] for o in self.store.list_objects("df_*")]
        self.assertEqual(names, ["df_a", "df_b"])

    def test_delete_removes_object(self):
        self.store.publish("x", 1, description="one")
        self.assertEqual(self.store.delete("x"), {"deleted": True, "version": 1})
        self.assertIsNone(self.store.get_meta("x"))
        self.assertEqual(self.store.list_objects(), [])

    def test_delete_missing_is_idempotent(self):
        self.assertEqual(self.store.delete("nope"), {"deleted": False, "version": None})
        self.assertEqual(self.store.delete("nope"), {"deleted": False, "version": None})

    def test_delete_with_expected_version(self):
        self.store.publish("x", 1, description="one")
        with self.assertRaises(storage.ConflictError):
            self.store.delete("x", expected_version=99)
        self.assertTrue(self.store.get_meta("x"), "conflict must not delete")
        self.assertEqual(self.store.delete("x", expected_version=1), {"deleted": True, "version": 1})

    def test_delete_resets_version_to_v1(self):
        self.store.publish("x", 1, description="one")
        self.store.publish("x", 2, description="two")
        self.store.delete("x")
        self.assertEqual(self.store.publish("x", 3, description="three"), {"version": 1, "overwritten": False})

    def test_delete_invalid_name(self):
        with self.assertRaises(PublishError):
            self.store.delete("_x")
    def test_concurrent_publish_from_two_connections(self):
        """Two connections (two sessions) publishing concurrently: SQLite
        serializes writers; both writes must survive (last-write-wins)."""
        other = GlobalStore(self.wd)
        try:
            self.store.publish("x", 1, description="one")
            other.publish("x", 2, description="two")
            self.assertEqual(self.store.get_meta("x")["version"], 2)
            self.assertEqual(other.get_meta("x")["version"], 2)
        finally:
            other.conn.close()


if __name__ == "__main__":
    unittest.main()
