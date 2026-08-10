"""Unit tests for the exec engine and RPC server (standard library unittest).

Run: python3 -m unittest discover -s tests/python -p 'test_*.py'
"""

import os
import signal
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "python"))

import server  # noqa: E402


class ExecEngineTest(unittest.TestCase):
    def setUp(self):
        self.engine = server.ExecEngine()

    def run_ok(self, code):
        result = self.engine.run(code)
        self.assertEqual(result.error, "", f"unexpected error: {result.error}")
        self.assertFalse(result.incomplete)
        return result

    def test_new_names(self):
        result = self.run_ok("x = 42\ny = [1, 2, 3]")
        self.assertEqual(result.new, [{"name": "x", "type": "int"}, {"name": "y", "type": "list"}])
        self.assertEqual(result.changed, [])
        self.assertEqual(result.removed, [])

    def test_changed_and_removed(self):
        self.run_ok("x = 1\ny = 2")
        result = self.run_ok("x = 99\ndel y")
        self.assertEqual(result.changed, ["x"])
        self.assertEqual(result.removed, ["y"])

    def test_private_names_ignored(self):
        result = self.run_ok("_tmp = 1\n__secret = 2")
        self.assertEqual(result.new, [])

    def test_in_place_mutation_not_reported(self):
        self.run_ok("y = [1]")
        result = self.run_ok("y.append(2)")
        self.assertEqual(result.changed, [])

    def test_bare_expression_display(self):
        self.run_ok("x = [1, 2, 3]")
        result = self.run_ok("x")
        self.assertIn("[1, 2, 3]", result.output)

    def test_bare_expression_none_not_displayed(self):
        self.run_ok("def f():\n    pass")
        result = self.run_ok("f()")
        self.assertEqual(result.output, "")

    def test_trailing_docstring_not_displayed(self):
        result = self.run_ok('"just a string"')
        self.assertEqual(result.output, "")

    def test_stdout_captured(self):
        result = self.run_ok("for i in range(3):\n    print(i)")
        self.assertEqual(result.output, "0\n1\n2\n")

    def test_error_has_traceback_and_keeps_state(self):
        result = self.engine.run("x = 5\n1 / 0")
        self.assertIn("ZeroDivisionError", result.error)
        self.assertEqual(result.new, [], "no diff reported on error")
        # partial execution bound x
        later = self.run_ok("x")
        self.assertIn("5", later.output)

    def test_incomplete_input(self):
        result = self.engine.run("if True:")
        self.assertTrue(result.incomplete)
        result = self.engine.run("def f():")
        self.assertTrue(result.incomplete)

    def test_keyboard_interrupt(self):
        result = self.engine.run(
            "import os, signal\nos.kill(os.getpid(), signal.SIGINT)\nx = 1"
        )
        self.assertTrue(result.interrupted)

    def test_state_persists_across_runs(self):
        self.run_ok("x = 40")
        self.run_ok("x += 2")
        result = self.run_ok("x")
        self.assertIn("42", result.output)

    def test_builtins_available(self):
        result = self.run_ok("len([1, 2])")
        self.assertIn("2", result.output)

    def test_import_module(self):
        result = self.run_ok("import json")
        self.assertEqual(result.new, [{"name": "json", "type": "module"}])

    def test_register_is_injected(self):
        self.run_ok("register('probe', lambda: 1, 'probe')")
        self.assertIn("probe", self.engine.registry_names())
        self.assertNotIn("register", {o["name"] for o in self.engine.session_snapshot()})
        self.assertNotIn("unregister", {o["name"] for o in self.engine.session_snapshot()})
        self.assertNotIn("register", self.engine.run("x = 1").new + self.engine.run("y = 2").new)
        self.assertNotIn("unregister", self.engine.run("x = 1").new + self.engine.run("y = 2").new)

    def test_register_explicit_function(self):
        self.run_ok(
            "def f(a, b=1):\n"
            "    \"\"\"First doc line.\n"
            "    Second line ignored.\"\"\"\n"
            "    return a + b\n"
            "register('f', f, 'Adds a and b.')\n"
        )
        entry = self.engine.registry_snapshot()[0]
        self.assertEqual(entry["name"], "f")
        self.assertEqual(entry["kind"], "function")
        self.assertEqual(entry["description"], "Adds a and b.")
        self.assertEqual(entry["detail"], "(a, b=1)")
        self.assertEqual(entry["doc"], "First doc line.")

    def test_register_decorator_docstring_fallback(self):
        self.run_ok(
            "@register('g')\n"
            "def g(x):\n"
            "    \"\"\"Doubles x.\"\"\"\n"
            "    return x * 2\n"
        )
        entry = self.engine.registry_snapshot()[0]
        self.assertEqual(entry["description"], "Doubles x.")
        self.assertEqual(entry["detail"], "(x)")

    def test_register_decorator_with_description(self):
        self.run_ok(
            "@register('h', description='Halves x.')\n"
            "def h(x):\n"
            "    \"\"\"Not used.\"\"\"\n"
            "    return x / 2\n"
        )
        self.assertEqual(self.engine.registry_snapshot()[0]["description"], "Halves x.")

    def test_register_decorator_positional_description(self):
        self.run_ok(
            "@register('h', 'Halves x.')\n"
            "def h(x):\n"
            "    \"\"\"Not used.\"\"\"\n"
            "    return x / 2\n"
        )
        entry = self.engine.registry_snapshot()[0]
        self.assertEqual(entry["name"], "h")
        self.assertEqual(entry["kind"], "function")
        self.assertEqual(entry["description"], "Halves x.")

    def test_register_bare_string_is_decorator_not_data(self):
        # A bare string in obj position means the decorator form: nothing
        # is registered until the returned decorator is applied.
        self.run_ok("deco = register('NAME', 'Acme')")
        self.assertEqual(self.engine.registry_names(), set())
        self.run_ok("deco(lambda: 1)")
        entry = self.engine.registry_snapshot()[0]
        self.assertEqual(entry["name"], "NAME")
        self.assertEqual(entry["description"], "Acme")

    def test_register_string_data_keyword_obj(self):
        self.run_ok("register('NAME', obj='Acme', description='Company name.')")
        entry = self.engine.registry_snapshot()[0]
        self.assertEqual(entry["kind"], "data")
        self.assertEqual(entry["detail"], "'Acme'")
        self.assertEqual(entry["description"], "Company name.")

    def test_register_rejects_mixed_positional_keyword_obj(self):
        result = self.engine.run("register('k', 1, obj=2)")
        self.assertIn("TypeError", result.error)

    def test_register_data_object(self):
        self.run_ok(
            "register('cfg', {'a': 1, 'b': [1, 2]}, 'Config dict.')\n"
            "register('NAME', 'Acme', 'Company name.')\n"
        )
        by_name = {e["name"]: e for e in self.engine.registry_snapshot()}
        cfg = by_name["cfg"]
        name = by_name["NAME"]
        self.assertEqual(cfg["kind"], "data")
        self.assertEqual(cfg["detail"], "dict len=2")
        self.assertEqual(cfg["doc"], "", "data objects must not inherit type docstrings")
        self.assertEqual(name["kind"], "data")
        self.assertEqual(name["detail"], "'Acme'")

    def test_register_overwrite(self):
        self.run_ok("register('k', 1, 'first')")
        self.run_ok("register('k', 2, 'second')")
        entries = self.engine.registry_snapshot()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["description"], "second")

    def test_register_overwrite_notice(self):
        first = self.engine.run("register('k', 1, 'first')")
        second = self.engine.run("register('k', 2, 'second')")
        self.assertNotIn("overwrote", first.output)
        self.assertIn("overwrote existing entry 'k'", second.output)
        self.assertIn("was data, now data", second.output)

    def test_unregister_drops_entry_and_binding(self):
        self.run_ok("register('k', 1, 'first')\nunregister('k')")
        self.assertEqual(self.engine.registry_names(), set())
        self.assertFalse(self.engine.has("k"))

    def test_unregister_idempotent(self):
        self.run_ok("register('k', 1, 'first')")
        result = self.engine.run("unregister('k')\nunregister('k')")
        self.assertEqual(result.error, "")
        self.assertEqual(self.engine.registry_names(), set())

    def test_unregister_keeps_user_reassignment(self):
        self.run_ok("register('k', 1, 'first')\nk = 99\nunregister('k')")
        self.assertEqual(self.engine.registry_names(), set())
        self.assertEqual(self.engine.get("k"), 99)

    def test_register_callable_object(self):
        self.engine.set("_adder", type("Adder", (), {"__call__": lambda self, a, b: a + b})())
        self.engine.run("register('adder', _adder, 'callable instance')")
        entry = self.engine.registry_snapshot()[0]
        self.assertEqual(entry["kind"], "callable")
        self.assertEqual(entry["detail"], "(a, b)")

@unittest.skipUnless(_ipython := server.make_executor().name == "ipython", "IPython not installed")
class IPythonEngineTest(unittest.TestCase):
    def setUp(self):
        self.engine = server.IPythonEngine()

    def test_magic_supported(self):
        result = self.engine.run("%time x = 1")
        self.assertEqual(result.error, "")

    def test_expression_display(self):
        self.engine.run("x = 7")
        result = self.engine.run("x")
        self.assertIn("7", result.output)

    def test_register_available(self):
        result = self.engine.run("register('ip', lambda: 1, 'ipython probe')")
        self.assertEqual(result.error, "")
        self.assertIn("ip", self.engine.registry_names())
        result = self.engine.run("unregister('ip')")
        self.assertEqual(result.error, "")
        self.assertNotIn("ip", self.engine.registry_names())

class RpcServerTest(unittest.TestCase):
    def make_server(self):
        return server.Server(server.ExecEngine(), tempfile.mkdtemp())

    def test_hello(self):
        srv = self.make_server()
        self.assertEqual(srv.handle({"method": "hello"})["engine"], "exec")

    def test_execute_roundtrip(self):
        srv = self.make_server()
        out = srv.handle({"method": "execute", "params": {"code": "a = 1"}})
        self.assertEqual(out["new"], [{"name": "a", "type": "int"}])
        out = srv.handle({"method": "execute", "params": {"code": "a"}})
        self.assertIn("1", out["output"])

    def test_execute_output_truncated(self):
        srv = self.make_server()
        out = srv.handle({"method": "execute", "params": {"code": "print('x' * 3000000)"}})
        self.assertTrue(out["output_truncated"])
        self.assertLess(len(out["output"]), server.MAX_OUTPUT_CHARS + 200)
        self.assertIn("truncated", out["output"][-80:])

    def test_execute_small_output_not_truncated(self):
        srv = self.make_server()
        out = srv.handle({"method": "execute", "params": {"code": "print('hi')"}})
        self.assertFalse(out["output_truncated"])
        self.assertEqual(out["output"], "hi\n")

    def test_hello_includes_cwd(self):
        srv = self.make_server()
        hello = srv.handle({"method": "hello"})
        self.assertTrue(hello["cwd"].startswith("/"))
    def test_unknown_method(self):
        srv = self.make_server()
        self.assertIsNone(srv.handle({"method": "nope"}))

    # -- init script replay -------------------------------------------------

    def init_server(self, init_code):
        wd = tempfile.mkdtemp()
        os.makedirs(os.path.join(wd, ".kernel"), exist_ok=True)
        with open(os.path.join(wd, ".kernel", "init.py"), "w") as f:
            f.write(init_code)
        return server.Server(server.ExecEngine(), wd)

    def test_init_script_registers_names(self):
        srv = self.init_server("def helper(x):\n    return x * 2\nCONST = 42\nprint('init ready')")
        hello = srv.handle({"method": "hello"})
        init = hello["init"]
        self.assertEqual(init["path"], ".kernel/init.py")
        self.assertIn("init ready", init["output"])
        names = [n["name"] for n in init["new"]]
        self.assertIn("helper", names)
        self.assertIn("CONST", names)
        # names usable by later execute calls
        out = srv.handle({"method": "execute", "params": {"code": "helper(CONST)"}})
        self.assertIn("84", out["output"])

    def test_init_script_registered_names_reported(self):
        srv = self.init_server(
            "@register('double', description='Doubles a number.')\n"
            "def double(x):\n"
            "    return x * 2\n"
            "register('CONST', 42, 'The answer.')\n"
        )
        init = srv.handle({"method": "hello"})["init"]
        self.assertEqual(init["registered"], ["CONST", "double"])
        # registered entries visible via ls and usable via execute
        ls = srv.handle({"method": "ls", "params": {"scope": "session"}})
        self.assertEqual([e["name"] for e in ls["registered"]], ["CONST", "double"])
        out = srv.handle({"method": "execute", "params": {"code": "double(CONST)"}})
        self.assertIn("84", out["output"])

    def test_init_script_overwrite_notice(self):
        srv = self.init_server("register('k', 1, 'first')\nregister('k', 2, 'second')")
        init = srv.handle({"method": "hello"})["init"]
        self.assertIn("overwrote existing entry 'k'", init["output"])

    def test_ls_includes_registered(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "register('cfg', {'a': 1}, 'Config.')"}})
        ls = srv.handle({"method": "ls", "params": {"scope": "session"}})
        self.assertEqual(len(ls["registered"]), 1)
        self.assertEqual(ls["registered"][0]["name"], "cfg")
        self.assertEqual(ls["registered"][0]["kind"], "data")
        self.assertEqual(ls["registered"][0]["detail"], "dict len=1")
        # pattern filters registered entries too
        ls2 = srv.handle({"method": "ls", "params": {"scope": "session", "pattern": "nomatch*"}})
        self.assertEqual(ls2["registered"], [])

    def test_unregister_reflected_in_ls(self):
        srv = self.make_server()
        srv.handle(
            {"method": "execute", "params": {"code": "register('cfg', {'a': 1}, 'Config.')\nunregister('cfg')"}}
        )
        ls = srv.handle({"method": "ls", "params": {"scope": "session"}})
        self.assertEqual(ls["registered"], [])
        self.assertNotIn("cfg", {o["name"] for o in ls["session"]})
    def test_init_script_error_reported(self):
        srv = self.init_server("raise ValueError('bad init')")
        init = srv.handle({"method": "hello"})["init"]
        self.assertIn("ValueError", init["error"])

    def test_no_init_script(self):
        srv = self.make_server()
        self.assertIsNone(srv.handle({"method": "hello"})["init"])

    def test_init_script_kernel_init_py_fallback(self):
        wd = tempfile.mkdtemp()
        with open(os.path.join(wd, "kernel_init.py"), "w") as f:
            f.write("v = 1")
        srv = server.Server(server.ExecEngine(), wd)
        init = srv.handle({"method": "hello"})["init"]
        self.assertEqual(init["path"], "kernel_init.py")
    def test_ls_lists_session_and_global(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "x = 1"}})
        out = srv.handle({"method": "ls", "params": {}})
        self.assertEqual([o["name"] for o in out["session"]], ["x"])
        self.assertEqual(out["global"], [])

    def test_publish_get_roundtrip(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "v = {'k': 42}"}})
        pub = srv.handle({"method": "publish", "params": {"name": "v", "description": "a dict"}})
        self.assertEqual(pub, {"version": 1, "overwritten": False, "name": "v"})
        got = srv.handle({"method": "get", "params": {"name": "v", "scope": "global"}})
        self.assertEqual(got["scope"], "global")
        self.assertTrue(got["loaded"])
        self.assertIn("k", got["summary"])

    def test_get_session_shadows_global(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "v = {'s': 1}"}})
        srv.handle({"method": "publish", "params": {"name": "v", "description": "global"}})
        got = srv.handle({"method": "get", "params": {"name": "v"}})
        self.assertEqual(got["scope"], "session")
        self.assertTrue(got["shadowed"])

    def test_get_global_covers_session_name(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "v = {'session': 1}"}})
        srv.handle({"method": "publish", "params": {"name": "v", "description": "global", "scope": "global"}})
        got = srv.handle({"method": "get", "params": {"name": "v", "scope": "global"}})
        self.assertEqual(got["scope"], "global")
        self.assertTrue(got["covered_session"])
    def test_publish_missing_session_object(self):
        srv = self.make_server()
        out = srv.handle({"method": "publish", "params": {"name": "nope", "description": "x"}})
        self.assertEqual(out["error"]["code"], "not_found")

    def test_delete_roundtrip(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "v = 1"}})
        srv.handle({"method": "publish", "params": {"name": "v", "description": "d"}})
        out = srv.handle({"method": "delete", "params": {"name": "v"}})
        self.assertEqual(out, {"name": "v", "deleted": True, "version": 1})
        ls = srv.handle({"method": "ls", "params": {"scope": "global"}})
        self.assertEqual(ls["global"], [])

    def test_delete_missing_is_idempotent(self):
        srv = self.make_server()
        out = srv.handle({"method": "delete", "params": {"name": "nope"}})
        self.assertEqual(out, {"name": "nope", "deleted": False, "version": None})

    def test_delete_version_conflict(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "v = 1"}})
        srv.handle({"method": "publish", "params": {"name": "v", "description": "d"}})
        out = srv.handle({"method": "delete", "params": {"name": "v", "expected_version": 99}})
        self.assertEqual(out["error"]["code"], "conflict")
        ls = srv.handle({"method": "ls", "params": {"scope": "global"}})
        self.assertEqual(len(ls["global"]), 1, "conflict must not delete")

    def test_delete_does_not_touch_session(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "v = 1"}})
        srv.handle({"method": "publish", "params": {"name": "v", "description": "d"}})
        srv.handle({"method": "delete", "params": {"name": "v"}})
        out = srv.handle({"method": "execute", "params": {"code": "v"}})
        self.assertIn("1", out["output"], "session variable survives global delete")
    def test_publish_requires_description(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "v = 1"}})
        out = srv.handle({"method": "publish", "params": {"name": "v", "description": ""}})
        self.assertEqual(out["error"]["code"], "publish")

    def test_publish_version_conflict(self):
        srv = self.make_server()
        srv.handle({"method": "execute", "params": {"code": "v = 1"}})
        srv.handle({"method": "publish", "params": {"name": "v", "description": "one"}})
        out = srv.handle({"method": "publish", "params": {"name": "v", "description": "two", "expected_version": 1}})
        self.assertEqual(out["version"], 2)
        self.assertTrue(out["overwritten"])
        out = srv.handle({"method": "publish", "params": {"name": "v", "description": "three", "expected_version": 99}})
        self.assertEqual(out["error"]["code"], "conflict")

    def test_stale_object_not_loaded_without_force(self):
        srv = self.make_server()
        src = os.path.join(tempfile.mkdtemp(), "src.txt")
        with open(src, "w") as f:
            f.write("v1")
        srv.handle({"method": "execute", "params": {"code": f"import builtins; data = builtins.open({src!r}).read()"}})
        srv.handle({"method": "publish", "params": {"name": "data", "description": "file content", "source": src}})
        with open(src, "w") as f:
            f.write("v2")
        out = srv.handle({"method": "get", "params": {"name": "data", "scope": "global"}})
        self.assertTrue(out["invalid"])
        out = srv.handle({"method": "get", "params": {"name": "data", "scope": "global", "force": True}})
        self.assertEqual(out["valid"], False, "forced load still reports staleness")
        self.assertEqual(out["summary"], "'v1'")


if __name__ == "__main__":
    unittest.main()
