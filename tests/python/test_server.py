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
