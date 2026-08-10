"""Unit tests for the exec engine and RPC server (standard library unittest).

Run: python3 -m unittest discover -s tests/python -p 'test_*.py'
"""

import os
import signal
import sys
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
    def test_hello(self):
        srv = server.Server(server.ExecEngine())
        self.assertEqual(srv.handle({"method": "hello"})["engine"], "exec")

    def test_execute_roundtrip(self):
        srv = server.Server(server.ExecEngine())
        out = srv.handle({"method": "execute", "params": {"code": "a = 1"}})
        self.assertEqual(out["new"], [{"name": "a", "type": "int"}])
        out = srv.handle({"method": "execute", "params": {"code": "a"}})
        self.assertIn("1", out["output"])

    def test_unknown_method(self):
        srv = server.Server(server.ExecEngine())
        self.assertIsNone(srv.handle({"method": "nope"}))


if __name__ == "__main__":
    unittest.main()
