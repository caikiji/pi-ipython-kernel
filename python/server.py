#!/usr/bin/env python3
"""Kernel server: embedded Python REPL over newline-delimited JSON on stdio.

Protocol (one JSON object per line, UTF-8):
  request:  {"id": n, "method": str, "params": {...}}
  response: {"id": n, "result": {...}}
            {"id": n, "error": {"code": str, "message": str}}

Methods:
  hello            -> {version, python, engine}
  execute {code}   -> {output, error, incomplete, interrupted,
                       new: [{name, type}], changed: [name], removed: [name]}
  shutdown         -> exits the process

Design notes (see RULES.md):
- Executor is an abstraction: IPython InteractiveShell when available,
  standard-library exec engine as the zero-dependency fallback.
- The namespace diff tracks top-level rebinding: new keys, removed keys,
  and keys whose object identity changed. In-place mutation (x.append)
  is not detected by design.
- The exec engine mirrors REPL behavior: a trailing bare expression
  (e.g. `df` or `1 + 1`) is evaluated and its repr is printed, so agents
  can inspect objects without print().
- SIGINT (sent by the host on timeout) raises KeyboardInterrupt inside
  exec, which is caught and reported as interrupted=True; the process
  keeps serving. The read loop swallows KeyboardInterrupt so a stray
  signal can never kill the process.
"""

from __future__ import annotations

import ast
import codeop
import contextlib
import io
import json
import os
import signal
import sys
import traceback
from dataclasses import dataclass, field

VERSION = "0.1.0"

# Names ignored in namespace diffs (IPython convention: leading underscore).
_PRIVATE = lambda name: name.startswith("_")  # noqa: E731


@dataclass
class ExecResult:
    output: str = ""
    error: str = ""
    incomplete: bool = False
    interrupted: bool = False
    new: list = field(default_factory=list)
    changed: list = field(default_factory=list)
    removed: list = field(default_factory=list)


class Executor:
    """Abstract executor: run code, capture output, diff the namespace."""

    name: str = "base"

    def __init__(self) -> None:
        self._ns: dict = self._new_namespace()

    # -- namespace ----------------------------------------------------

    def _new_namespace(self) -> dict:
        return {"__name__": "__kernel__"}

    def _snapshot(self) -> dict:
        """Map of public name -> object id, for rebinding detection."""
        return {k: id(v) for k, v in self._ns.items() if not _PRIVATE(k)}

    def _diff(self, before: dict) -> tuple:
        after = self._snapshot()
        new = [
            {"name": k, "type": type(self._ns[k]).__name__}
            for k in sorted(after.keys() - before.keys())
        ]
        changed = sorted(k for k in before.keys() & after.keys() if before[k] != after[k])
        removed = sorted(before.keys() - after.keys())
        return new, changed, removed

    # -- execution ----------------------------------------------------

    def run(self, code: str) -> ExecResult:
        before = self._snapshot()
        out = io.StringIO()
        err = io.StringIO()
        result = ExecResult()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self._execute(code, result)
        except KeyboardInterrupt:
            result.interrupted = True
            result.error = "KeyboardInterrupt"
        except BaseException:  # noqa: BLE001 - report every failure to the agent
            result.error = traceback.format_exc()
        result.output = out.getvalue()
        if err.getvalue() and not result.error:
            result.output += err.getvalue()
        if not result.error and not result.interrupted:
            result.new, result.changed, result.removed = self._diff(before)
        return result

    def _execute(self, code: str, result: ExecResult) -> None:
        raise NotImplementedError


class ExecEngine(Executor):
    """Zero-dependency engine built on codeop/exec (any Python 3.10+)."""
    name = 'exec'

    def __init__(self) -> None:
        super().__init__()

    def _execute(self, code: str, result: ExecResult) -> None:
        compiled = codeop.compile_command(code, '<kernel-exec>', 'exec')
        if compiled is None:
            result.incomplete = True
            return
        exec(compiled, self._ns)
        self._display_bare_expression(code, result)

    def _display_bare_expression(self, code: str, result: ExecResult) -> None:
        """REPL-like: print repr() of a trailing bare expression, e.g. `df`."""
        try:
            tree = ast.parse(code)
        except SyntaxError:
            return
        body = tree.body
        if not body:
            return
        last = body[-1]
        if not isinstance(last, ast.Expr):
            return
        if isinstance(last.value, ast.Constant) and isinstance(last.value.value, str):
            return  # trailing docstring/comment-like string
        segment = ast.get_source_segment(code, last.value)
        if not segment:
            return
        value = eval(compile(ast.Expression(last.value), "<kernel-exec>", "eval"), self._ns)
        if value is not None:
            print(repr(value))


class IPythonEngine(Executor):
    """Embedded IPython InteractiveShell engine (used when IPython is installed)."""

    name = "ipython"

    def __init__(self) -> None:
        super().__init__()
        from IPython.core.interactiveshell import InteractiveShell

        self._shell = InteractiveShell.instance()
        self._shell.run_cell("pass")  # ensure init before first snapshot
        self._ns = self._shell.user_ns

    def _execute(self, code: str, result: ExecResult) -> None:
        from IPython.core.error import InputRejected

        try:
            cell = self._shell.run_cell(code, store_history=False)
        except InputRejected:
            result.incomplete = True
            return
        if cell.error_before_exec:
            result.error = cell.error_before_exec.__repr__()
        elif cell.error_in_exec:
            result.error = "".join(
                traceback.format_exception(type(cell.error_in_exec), cell.error_in_exec, cell.error_in_exec.__traceback__)
            )


def make_executor() -> Executor:
    try:
        import IPython  # noqa: F401

        return IPythonEngine()
    except ImportError:
        return ExecEngine()


# -- RPC server --------------------------------------------------------


class Server:
    def __init__(self, executor: Executor) -> None:
        self.executor = executor

    def handle(self, msg: dict) -> dict | None:
        method = msg.get("method")
        params = msg.get("params") or {}
        if method == "hello":
            return {"version": VERSION, "python": sys.version.split()[0], "engine": self.executor.name}
        if method == "execute":
            return self.handle_execute(str(params.get("code", "")))
        if method == "shutdown":
            os._exit(0)
        return None

    def handle_execute(self, code: str) -> dict:
        result = self.executor.run(code)
        return {
            "output": result.output,
            "error": result.error,
            "incomplete": result.incomplete,
            "interrupted": result.interrupted,
            "new": result.new,
            "changed": result.changed,
            "removed": result.removed,
        }


def main() -> None:
    # Default SIGINT handling: the host sends SIGINT on timeout, which
    # raises KeyboardInterrupt inside exec (caught by Executor.run and
    # reported as interrupted). Any KeyboardInterrupt landing in the main
    # loop (e.g. while blocked on readline) is swallowed so the process
    # keeps serving.
    server = Server(make_executor())
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    while True:
        try:
            raw = stdin.readline()
            if not raw:
                return  # stdin closed: host is gone
            line = raw.decode('utf-8', errors='replace').strip()
            if not line:
                continue
            msg = json.loads(line)
            rid = msg.get('id')
            try:
                result = server.handle(msg)
                if result is None and rid is not None:
                    result = {'ok': True}
                payload = {'id': rid, 'result': result} if rid is not None else None
            except Exception as exc:  # noqa: BLE001
                payload = {'id': rid, 'error': {'code': 'internal', 'message': str(exc)}}
            if payload is not None:
                stdout.write((json.dumps(payload) + '\n').encode('utf-8'))
                stdout.flush()
        except KeyboardInterrupt:
            continue


if __name__ == '__main__':
    main()
