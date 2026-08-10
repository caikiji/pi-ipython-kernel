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
  ls {scope, pattern}                        -> {session, registered, global}
  get {name, summarize, scope, force}        -> object meta + summary/full
  publish {name, description, source, expected_version}
                   -> {name, version, overwritten}
  delete {name, expected_version}            -> {name, deleted, version}
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
import inspect
import io
import json
import os
import signal
import sys
import traceback
from dataclasses import dataclass, field

import storage
import summarize

VERSION = "0.1.0"

# Upper bound for captured stdout/stderr returned to the host; protects
# the RPC channel from accidental giant prints (e.g. printing a huge
# dataframe). Truncated output is flagged, never silently dropped.
MAX_OUTPUT_CHARS = 2 * 1024 * 1024
# Names ignored in namespace diffs (IPython convention: leading underscore).
_PRIVATE = lambda name: name.startswith("_")  # noqa: E731

# Names IPython injects into user_ns; not user objects, never listed.
_IPYTHON_RESERVED = frozenset({"In", "Out", "get_ipython", "exit", "quit", "open"})

# Names the kernel injects into the session namespace; never listed as user
# objects. `register` is the registration DSL used by init scripts and by
# agents from kernel_run (session-scoped only).
_KERNEL_BUILTINS = frozenset({"register"})

# Sentinel: distinguishes "obj not given" from obj=None in register().
_UNSET = object()


def _describe_registrable(obj) -> tuple[str, str, str]:
    """(kind, detail, doc) for a register() entry.

    kind: function / callable / data. detail: the call signature for
    callables, a one-line structural summary for data. doc: first line of
    the docstring, if any."""
    if inspect.isfunction(obj):
        kind = "function"
    elif callable(obj):
        kind = "callable"
    else:
        kind = "data"
    doc = ""
    if kind in ("function", "callable"):
        try:
            raw = inspect.getdoc(obj)
            if raw:
                doc = raw.strip().splitlines()[0].strip()
        except Exception:  # noqa: BLE001 - docs are best-effort
            pass
        pass
    if kind in ("function", "callable"):
        try:
            detail = str(inspect.signature(obj))
        except (ValueError, TypeError):
            detail = ""
    else:
        try:
            detail = summarize.summarize(obj, max_chars=300).splitlines()[0].strip()
        except Exception:  # noqa: BLE001 - summaries are best-effort
            detail = ""
    if len(detail) > 200:
        detail = detail[:197] + "..."
    return kind, detail, doc


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
        # Registry of named callables/data declared via register() (replay
        # layer: rebuilt from the init script on every session start).
        self._registry: dict[str, dict] = {}

    # -- namespace ----------------------------------------------------

    def _new_namespace(self) -> dict:
        ns = {"__name__": "__kernel__"}
        ns["register"] = self._make_register()
        return ns

    def _make_register(self):
        """Registration DSL shared by init scripts and kernel_run.

        register(name, obj, description="")  -> registers obj, returns obj
        @register(name, description="")      -> decorator; returns the fn
        @register(name, "description")       -> decorator, positional description

        The description falls back to the docstring's first line. A bare
        string in obj position (positional, without description=) is taken
        as the description — the documented decorator form; to register
        string data explicitly, use obj= or a third positional argument:
        register(name, obj="...", description="...").
        """

        def deco(name, description):
            def wrap(fn):
                self._do_register(name, fn, description)
                return fn

            return wrap

        def register(name, *args, obj=_UNSET, description=""):
            if len(args) > 2:
                raise TypeError(
                    f"register() takes at most 3 positional arguments ({len(args) + 1} given)"
                )
            if args and obj is not _UNSET:
                raise TypeError("register(): 'obj' given both positionally and as a keyword")
            if len(args) == 2:
                if description:
                    raise TypeError(
                        "register(): 'description' given both positionally and as a keyword"
                    )
                obj, description = args
            elif len(args) == 1:
                obj = args[0]
            if args and isinstance(obj, str) and not description:
                # @register(name, "desc"): a bare positional string is the
                # description (decorator form), not the registered object.
                return deco(name, obj)
            if obj is _UNSET:
                return deco(name, description)
            self._do_register(name, obj, description)
            return obj

        register.__doc__ = type(self)._make_register.__doc__
        return register

    def _do_register(self, name: str, obj, description: str) -> None:
        kind, detail, doc = _describe_registrable(obj)
        self._registry[name] = {
            "name": name,
            "kind": kind,
            "description": description or doc,
            "detail": detail,
            "doc": doc,
        }
        # Registered names are usable in the session namespace (direct
        # calls/references); ls hides them from the SESSION section because
        # the REGISTERED section already shows them.
        self._ns[name] = obj

    def registry_names(self) -> set[str]:
        return set(self._registry)

    def registry_snapshot(self) -> list[dict]:
        """Registered entries (name/kind/description/detail/doc), sorted."""
        return [self._registry[k] for k in sorted(self._registry)]

    def _snapshot(self) -> dict:
        """Map of public name -> object id, for rebinding detection."""
        return {
            k: id(v)
            for k, v in self._ns.items()
            if not _PRIVATE(k) and k not in _KERNEL_BUILTINS and k not in self._registry
        }

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

    # -- session namespace access (used by ls/get/publish) ----------------

    def session_snapshot(self) -> list[dict]:
        """Public top-level names of the session namespace (sorted)."""
        return sorted(
            (
                {"name": k, "type": type(v).__name__}
                for k, v in self._ns.items()
                if not _PRIVATE(k) and k not in _IPYTHON_RESERVED and k not in _KERNEL_BUILTINS and k not in self._registry
            ),
            key=lambda o: o["name"],
        )

    def has(self, name: str) -> bool:
        return name in self._ns

    def get(self, name: str):
        return self._ns[name]

    def set(self, name: str, value) -> None:
        self._ns[name] = value


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
        tail = self._extract_tail_expression(code)
        if tail is not None:
            # Compile the remaining statements (the tail expression was
            # removed so it is evaluated once below, never twice).
            tree = ast.parse(code)
            tree.body = tree.body[:-1]
            compiled = compile(ast.Module(body=tree.body, type_ignores=[]), '<kernel-exec>', 'exec')
        exec(compiled, self._ns)
        if tail is not None:
            value = eval(compile(ast.Expression(tail), '<kernel-exec>', 'eval'), self._ns)
            if value is not None:
                print(repr(value))

    def _extract_tail_expression(self, code: str) -> ast.AST | None:
        """Return the last statement's expression for REPL-style display.

        Only a trailing bare expression qualifies (e.g. `df`, `1 + 1`);
        trailing strings (docstrings) are left in place. The expression is
        evaluated exactly once: it is removed from the exec body and eval'd
        separately, so side effects like print() never run twice."""
        try:
            tree = ast.parse(code)
        except SyntaxError:
            return None
        if not tree.body:
            return None
        last = tree.body[-1]
        if not isinstance(last, ast.Expr):
            return None
        if isinstance(last.value, ast.Constant) and isinstance(last.value.value, str):
            return None
        return last.value

class IPythonEngine(Executor):
    """Embedded IPython InteractiveShell engine (used when IPython is installed)."""

    name = "ipython"

    def __init__(self) -> None:
        super().__init__()
        from IPython.core.interactiveshell import InteractiveShell

        # Plain output: colored tracebacks would leak ANSI escapes into
        # agent-visible tool results.
        self._shell = InteractiveShell.instance()
        self._shell.colors = "NoColor"
        self._shell.run_cell("pass")  # ensure init before first snapshot
        self._ns = self._shell.user_ns
        # Re-inject the registration DSL: base-class namespace is replaced
        # by the shell's user_ns above.
        self._ns["register"] = self._make_register()

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
    def __init__(self, executor: Executor, workspace: str) -> None:
        self.executor = executor
        self.store = storage.GlobalStore(workspace)
        # Replay layer (RULES.md): an init script is executed into the
        # session namespace at startup, so code/functions defined there
        # are re-registered on every fresh session instead of snapshotted.
        self.init_report = load_init_script(executor, workspace)

    def handle(self, msg: dict) -> dict | None:
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            return self._dispatch(method, params)
        except storage.ConflictError as exc:
            return {"error": {"code": "conflict", "message": str(exc)}}
        except storage.PublishError as exc:
            return {"error": {"code": "publish", "message": str(exc)}}
        except KeyError as exc:
            return {"error": {"code": "not_found", "message": str(exc)}}

    def _dispatch(self, method: str, params: dict) -> dict | None:
        if method == "hello":
            return {
                "version": VERSION,
                "python": sys.version.split()[0],
                "engine": self.executor.name,
                "cwd": os.getcwd(),
                "init": self.init_report,
            }
        if method == "execute":
            return self.handle_execute(str(params.get("code", "")))
        if method == "ls":
            return self.handle_ls(params)
        if method == "get":
            return self.handle_get(params)
        if method == "publish":
            return self.handle_publish(params)
        if method == "delete":
            return self.handle_delete(params)
        if method == "shutdown":
            os._exit(0)
        return None

    def handle_execute(self, code: str) -> dict:
        result = self.executor.run(code)
        output = result.output
        truncated = False
        if len(output) > MAX_OUTPUT_CHARS:
            output = output[:MAX_OUTPUT_CHARS] + f"\n... [output truncated at {MAX_OUTPUT_CHARS} chars]"
            truncated = True
        return {
            "output": output,
            "output_truncated": truncated,
            "error": result.error,
            "incomplete": result.incomplete,
            "interrupted": result.interrupted,
            "new": result.new,
            "changed": result.changed,
            "removed": result.removed,
        }

    # -- global layer ---------------------------------------------------

    def handle_ls(self, params: dict) -> dict:
        scope = params.get("scope", "all")
        pattern = params.get("pattern") or None
        out: dict = {}
        if scope in ("all", "session"):
            out["session"] = [
                o for o in self.executor.session_snapshot() if pattern is None or _match_name(pattern, o["name"])
            ]
            out["registered"] = [
                e for e in self.executor.registry_snapshot() if pattern is None or _match_name(pattern, e["name"])
            ]
        if scope in ("all", "global"):
            out["global"] = self.store.list_objects(pattern)
        return out

    def handle_get(self, params: dict) -> dict:
        name = str(params.get("name", ""))
        want_summary = bool(params.get("summarize", True))
        scope = str(params.get("scope", "auto"))
        force = bool(params.get("force", False))

        if scope == "session" or (scope == "auto" and self.executor.has(name)):
            obj = self.executor.get(name)
            meta = {
                "name": name,
                "scope": "session",
                "type": type(obj).__name__,
                "valid": True,
                "shadowed": self.store.get_meta(name) is not None,
            }
            return self._get_result(meta, obj, want_summary)

        covered_session = False
        if self.executor.has(name):
            # Explicit global request overwrites a same-name session
            # variable (e.g. verifying right after publish); the old
            # session value is replaced by the loaded global one.
            covered_session = True
        meta = self.store.get_meta(name)
        if meta is None:
            raise KeyError(f"no object named {name!r} in session or global layer")
        if not meta["valid"] and not force:
            return {"invalid": True, "name": name, "invalid_reason": meta["invalid_reason"], "meta": meta}
        _, obj = self.store.load(name, force=force)
        self.executor.set(name, obj)
        meta["scope"] = "global"
        meta["loaded"] = True
        if covered_session:
            meta["covered_session"] = True
        return self._get_result(meta, obj, want_summary)

    def _get_result(self, meta: dict, obj: Any, want_summary: bool) -> dict:
        out = dict(meta)
        out["summary"] = summarize.summarize(obj) if want_summary else ""
        if not want_summary:
            out["full"] = summarize.full_text(obj)
        return out

    def handle_publish(self, params: dict) -> dict:
        name = str(params.get("name", ""))
        description = str(params.get("description", ""))
        source = params.get("source") or None
        expected_version = params.get("expected_version")
        if not self.executor.has(name):
            raise KeyError(f"no session object named {name!r} to publish (define it with kernel_run first)")
        obj = self.executor.get(name)
        result = self.store.publish(
            name, obj, description=description, source=source,
            expected_version=int(expected_version) if expected_version is not None else None,
        )
        result["name"] = name
        return result

    def handle_delete(self, params: dict) -> dict:
        name = str(params.get("name", ""))
        expected_version = params.get("expected_version")
        result = self.store.delete(
            name,
            expected_version=int(expected_version) if expected_version is not None else None,
        )
        result["name"] = name
        return result



def _match_name(pattern: str, name: str) -> bool:
    import fnmatch

    return fnmatch.fnmatchcase(name, pattern)


def load_init_script(executor: Executor, workspace: str) -> dict | None:
    """Run the workspace init script (if any) into the session namespace.

    Candidates, in order: .kernel/init.py (machine-local, gitignored) and
    kernel_init.py (project root, committable). The report travels with the
    hello response so the host can surface failures once per process."""
    for rel in (".kernel/init.py", "kernel_init.py"):
        path = os.path.join(workspace, rel)
        if not os.path.isfile(path):
            continue
        before_registry = executor.registry_names()
        try:
            with open(path, encoding="utf-8") as f:
                code = f.read()
        except OSError as exc:
            return {"path": rel, "output": "", "error": f"cannot read init script: {exc}"}
        result = executor.run(code)
        registered = sorted(executor.registry_names() - before_registry)
        return {
            "path": rel,
            "output": result.output,
            "error": result.error,
            "new": result.new,
            "changed": result.changed,
            "registered": registered,
        }
    return None


def main() -> None:
    # Default SIGINT handling: the host sends SIGINT on timeout, which
    # raises KeyboardInterrupt inside exec (caught by Executor.run and
    # reported as interrupted). Any KeyboardInterrupt landing in the main
    # loop (e.g. while blocked on readline) is swallowed so the process
    # keeps serving.
    server = Server(make_executor(), os.getcwd())
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
                if isinstance(result, dict) and isinstance(result.get('error'), dict):
                    payload = {'id': rid, 'error': result['error']} if rid is not None else None
                else:
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
