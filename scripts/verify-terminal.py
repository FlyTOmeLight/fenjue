"""Offline PTY + tmux acceptance; add --native to also exercise installed Codex."""
import errno
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unicodedata

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
assert NODE and shutil.which("tmux"), "Install Node.js and tmux first"
seen = []
native_requests = 0
release_hold = threading.Event()


class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        global native_requests
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        seen.append((body["model"], body["reasoning"]["effort"]))
        if body.get("stream"):
            native_requests += 1
            text = ("```\nNATIVE_HISTORY_START\n" + "\n".join(f"NATIVE_LINE_{i}" for i in range(180))
                    + "\nNATIVE_HISTORY_END\n```") if native_requests == 1 else "NATIVE_CONTINUED"
            item = {"type": "message", "id": f"msg_{native_requests}", "role": "assistant", "phase": "final_answer",
                    "content": [{"type": "output_text", "text": text, "annotations": []}]}
            response = {"id": f"resp_{native_requests}", "object": "response", "status": "completed", "model": body["model"],
                        "output": [item], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
            events = [
                {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}},
                {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": response},
            ]
            reply = "".join(f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': i})}\n\n"
                            for i, event in enumerate(events)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)
            return
        if body["input"][-1]["content"] == "hold":
            release_hold.wait(10)
        reply = "REPLY 中文🙂".encode()
        try:
            self.send_response(200)
            self.send_header("Content-Length", str(len(reply)))
            self.send_header("openai-model", body["model"])
            self.end_headers()
            self.wfile.write(reply)
        except (BrokenPipeError, ConnectionResetError):
            pass


FIXTURE = r'''#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2), settings = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
  const value = args[++i], split = value.indexOf('=');
  try { settings[value.slice(0, split)] = JSON.parse(value.slice(split + 1)); } catch {}
}
writeFileSync(process.env.FENJUE_TEST_STATE, JSON.stringify({
  socket: process.env.TMUX?.split(',')[0], catalog: settings.model_catalog_json,
  url: settings['model_providers.fenjue.base_url'],
  internalMarker: process.env.FENJUE_TMUX_SOCKET,
}));
if (process.env.FENJUE_TEST_EARLY_EXIT) { process.stderr.write('STARTUP_FAILURE\n'); process.exit(42); }
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let abort;
const history = [];
process.stdout.write('READY\n');
process.stdout.on('resize', () => process.stdout.write(`SIZE=${process.stdout.columns}x${process.stdout.rows}\n`));
rl.on('SIGINT', () => { abort?.abort(); process.stdout.write('CANCELLED\n'); });
rl.on('line', async text => {
  if (text === '/exit') { rl.close(); process.exitCode = 7; return; }
  if (text === '/title') { process.stdout.write('\x1b]0;焚诀任务 中文🙂\x07'); return; }
  if (text === '/history') {
    process.stdout.write('HISTORY_START\n' + Array.from({length: 180}, (_, i) => `HISTORY_LINE_${i}`).join('\n') + '\nHISTORY_END\n');
    return;
  }
  history.push({ role: 'user', content: text });
  abort = new AbortController();
  try {
    const response = await fetch(settings['model_providers.fenjue.base_url'] + '/responses', {
      method: 'POST', signal: abort.signal,
      headers: { 'x-fenjue-token': process.env.FENJUE_PROXY_TOKEN },
      body: JSON.stringify({ model: 'fenjue-auto', prompt_cache_key: 'terminal-fixture', input: history }),
    });
    process.stdout.write(await response.text() + '\n');
  } catch (error) { if (error.name !== 'AbortError') throw error; }
});
'''


class Terminal:
    def __init__(self, argv, env):
        self.output = bytearray()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execve(NODE, [NODE, *argv], env)
        self.resize(100, 30)
        self.exited = False

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def read(self):
        if select.select([self.fd], [], [], 0.05)[0]:
            try:
                self.output.extend(os.read(self.fd, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise

    def until(self, condition, description, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read()
            if condition():
                return
        raise AssertionError(f"Timeout: {description}\n{self.output[-5000:].decode(errors='replace')!r}")

    def contains(self, text):
        return text.encode() in self.output

    def send(self, text):
        os.write(self.fd, text.encode())

    def pane_format(self, socket, value):
        return subprocess.check_output(["tmux", "-S", socket, "display-message", "-p", "-t", "fenjue:0.0", value], text=True).strip()

    def check_mouse_copy(self, socket, marker, sink):
        # Exercise actual terminal mouse input; use a private copy-command sink
        # so verification never overwrites the user's system clipboard.
        subprocess.check_call(["tmux", "-S", socket, "set-option", "-s", "copy-command",
                               "cat > " + shlex.quote(str(sink))])
        lines = subprocess.check_output(["tmux", "-S", socket, "capture-pane", "-p", "-t", "fenjue:0.0"], text=True).splitlines()
        row, line = next((i + 1, line) for i, line in enumerate(lines) if marker in line)
        def cells(text):
            return sum(2 if unicodedata.east_asian_width(char) in ("W", "F") else 1 for char in text)
        start = cells(line[:line.index(marker)]) + 1
        end = start + cells(marker)
        self.send(f"\x1b[<0;{start};{row}M")
        self.send(f"\x1b[<32;{end};{row}M")
        self.until(lambda: self.pane_format(socket, "#{pane_in_mode}:#{selection_present}") == "1:1",
                   "mouse drag starts a visible text selection", timeout=3)
        self.send(f"\x1b[<0;{end};{row}m")
        self.until(lambda: sink.exists() and sink.read_text() == marker,
                   "mouse drag copies selected text to clipboard command", timeout=3)
        copied = subprocess.check_output(["tmux", "-S", socket, "show-buffer"], text=True)
        assert copied == marker, "Mouse selection must copy exactly the selected text"
        self.until(lambda: self.pane_format(socket, "#{pane_in_mode}") == "0",
                   "mouse release returns to live input")
        # Separate standalone gestures: tmux's delayed double-click event can
        # otherwise arrive in the copy-mode entered by the next scroll check.
        settled = time.monotonic() + 0.35
        self.until(lambda: time.monotonic() >= settled,
                   "mouse click timer settles", timeout=1)
        assert self.pane_format(socket, "#{pane_in_mode}") == "0"

    def check_scrollback(self, socket, marker):
        assert int(self.pane_format(socket, "#{history_size}")) >= 150, "Response must overflow the viewport"
        live = subprocess.check_output(["tmux", "-S", socket, "capture-pane", "-p", "-t", "fenjue:0.0"], text=True)
        assert marker not in live, "Old marker must be above the live viewport"
        before = len(self.output)
        # Check the actual repaint after SGR wheel events: capture-pane can
        # return the underlying live screen even while copy-mode is visible.
        self.send("\x1b[<64;10;10M" * 100)
        self.until(lambda: self.pane_format(socket, "#{pane_in_mode}") == "1"
                   and marker.encode() in self.output[before:], "wheel up reveals old output")
        self.send("\x1b[<65;10;10M" * 120)
        self.until(lambda: self.pane_format(socket, "#{pane_in_mode}") == "0", "wheel down returns to live input")
        self.send("\x1b[<64;10;10M")
        self.until(lambda: self.pane_format(socket, "#{pane_in_mode}") == "1", "wheel up re-enters history")
        self.send("\x1b")
        self.until(lambda: self.pane_format(socket, "#{pane_in_mode}") == "0", "Escape returns to live input")

    def wait(self):
        result = None

        def exited():
            nonlocal result
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.exited = True
                result = os.waitstatus_to_exitcode(status)
                return True
            return False

        self.until(exited, "wrapper exit")
        return result

    def close(self):
        if not self.exited:
            os.kill(self.pid, signal.SIGTERM)
            self.wait()
        os.close(self.fd)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix="fenjue-terminal-") as directory:
        temp = Path(directory)
        cli = temp / "fixture.mjs"
        cli.write_text(FIXTURE)
        cli.chmod(0o700)
        models = [{"slug": name, "display_name": name, "base_instructions": "Fixture",
                   "default_reasoning_level": "low", "context_window": 100000,
                   "supported_reasoning_levels": [{"effort": e, "description": e} for e in ["low", "high"]]}
                  for name in ["fixture-fast", "fixture-deep"]]
        (temp / "models.json").write_text(json.dumps({"models": models}))
        (temp / "config.json").write_text(json.dumps({
            "version": 1, "auth": "mock", "upstream": f"http://127.0.0.1:{server.server_port}",
            "catalog": "models.json", "defaultRoute": "fast",
            "routes": {"fast": {"model": "fixture-fast", "effort": "low"},
                       "deep": {"model": "fixture-deep", "effort": "high"}},
            "rules": [{"prefix": "[deep]", "route": "deep"}],
        }))
        state_file = temp / "state.json"
        env = {"PATH": os.environ["PATH"], "LANG": "en_US.UTF-8", "TERM": "xterm-256color",
               "FENJUE_CODEX_BIN": str(cli), "FENJUE_TEST_STATE": str(state_file)}
        argv = [str(ROOT / "dist/src/cli.js"), "codex", "--config", str(temp / "config.json"), "--log-dir", str(temp / "logs")]
        terminal = Terminal(argv, env)
        try:
            terminal.until(lambda: terminal.contains("READY") and terminal.contains("焚诀"), "visible initial bottom bar")
            state = json.loads(state_file.read_text())
            assert "internalMarker" not in state
            terminal.send("/title\n")
            terminal.until(lambda: re.search(rb'\x1b\][02];' + "焚诀任务 中文🙂".encode() + rb'(?:\x07|\x1b\\)', terminal.output),
                           "pane title reaches the outer terminal as OSC")
            terminal.check_mouse_copy(state["socket"], "READY", temp / "copied.txt")

            def bar_contains(text):
                value = subprocess.check_output(["tmux", "-S", state["socket"], "display-message", "-p", "-t", "fenjue:0.0", "#{T:status-format[0]}"], text=True)
                return text in value

            for prompt, model, effort in [("normal", "fixture-fast", "low"), ("[deep] difficult", "fixture-deep", "high"), ("new task", "fixture-fast", "low")]:
                terminal.send(prompt + "\n")
                terminal.until(lambda: seen[-1:] == [(model, effort)] and bar_contains(f"请求 {model} · {effort}") and bar_contains("HTTP 200"), "route and bottom bar update")
            terminal.until(lambda: terminal.contains("fixture-fast") and terminal.contains("high"), "route text emitted to actual terminal")
            terminal.check_mouse_copy(state["socket"], "REPLY 中文🙂", temp / "copied-unicode.txt")
            terminal.send("/history\n")
            terminal.until(lambda: terminal.contains("HISTORY_END"), "long history produced")

            terminal.check_scrollback(state["socket"], "HISTORY_START")
            terminal.resize(82, 25)
            terminal.until(lambda: terminal.contains("SIZE=82x24"), "resize preserves one bottom row")
            terminal.send("hold\n")
            terminal.until(lambda: bar_contains("已发出"), "pending request status")
            terminal.send("\x03")
            terminal.until(lambda: terminal.contains("CANCELLED") and bar_contains("已取消"), "Ctrl-C cancels request and preserves session")
            terminal.send("after cancel\n")
            terminal.until(lambda: bar_contains("HTTP 200"), "session remains usable after Ctrl-C")
            terminal.send("/exit\n")
            assert terminal.wait() == 7, "Wrapper must preserve child exit code"
            assert not Path(state["socket"]).exists(), "tmux socket left behind"
            assert not Path(state["catalog"]).exists(), "proxy catalog left behind"
        finally:
            terminal.close()

        # A child may exit before the outer client attaches: it must not hang.
        terminal = Terminal(argv, {**env, "FENJUE_TEST_EARLY_EXIT": "1"})
        try:
            assert terminal.wait() == 42
            restored = terminal.output.rfind(b'\x1b[?1049l')
            assert b'STARTUP_FAILURE' in terminal.output[restored if restored >= 0 else 0:], "Startup error must remain visible after leaving tmux"
            assert not Path(json.loads(state_file.read_text())["socket"]).exists()
        finally:
            terminal.close()

        # tmux reports pane signals as names (macOS) or numbers (Linux).
        killed = temp / "killed.mjs"
        killed.write_text('process.kill(process.pid, "SIGTERM");')
        supervisor = temp / "signal-session.mjs"
        supervisor.write_text(
            f'import {{ startTmuxSession }} from {json.dumps((ROOT / "dist/src/tmux.js").as_uri())};\n'
            'const session = await startTmuxSession([process.argv[2]]);\n'
            'try { process.exitCode = await session.attach(); } finally { await session.close(); }\n')
        terminal = Terminal([str(supervisor), str(killed)], env)
        try:
            actual = terminal.wait()
            assert actual == 143, f"Pane termination signal must preserve exit status: got {actual}; output={terminal.output[-2000:]!r}"
        finally:
            terminal.close()

        terminal = Terminal(argv, env)
        try:
            terminal.until(lambda: terminal.contains("READY"), "session for termination check")
            state = json.loads(state_file.read_text())
            os.kill(terminal.pid, signal.SIGTERM)
            assert terminal.wait() == 143
            terminal.until(lambda: not Path(state["socket"]).exists() and not Path(state["catalog"]).exists(), "termination cleanup")
        finally:
            terminal.close()

        checks = ["visible bottom bar", "pane title forwarded to outer terminal", "mouse drag selection + clipboard command", "low/high/low routing", "wheel scrollback", "wheel down + Escape resume input",
                  "terminal resize", "Ctrl-C cancellation", "continued input", "child exit status", "visible early failure",
                  "pane signal status", "SIGTERM cleanup"]
        if "--native" in sys.argv:
            codex = os.environ.get("FENJUE_CODEX_BIN") or shutil.which("codex")
            assert codex, "Install Codex CLI for --native"
            bundled = json.loads(subprocess.check_output([codex, "debug", "models", "--bundled"], text=True))
            template = next(model for model in bundled["models"] if model["slug"] == "gpt-6.1-sol")
            (temp / "models.json").write_text(json.dumps({"models": [{**template, "slug": name} for name in ["fixture-fast", "fixture-deep"]]}))
            native = temp / "native.mjs"
            native.write_text('import { writeFileSync } from "node:fs";\n'
                              'import { spawnSync } from "node:child_process";\n'
                              'writeFileSync(process.env.FENJUE_TEST_STATE, JSON.stringify({socket:process.env.TMUX.split(",")[0]}));\n'
                              'const child = spawnSync(process.env.FENJUE_TEST_NATIVE_CODEX, process.argv.slice(2), {stdio:"inherit"});\n'
                              'process.exit(child.status ?? 1);\n')
            native.write_text('#!/usr/bin/env node\n' + native.read_text())
            native.chmod(0o700)
            codex_home = temp / "codex-home"
            codex_home.mkdir()
            (codex_home / "config.toml").write_text(
                "\n".join(f'[projects.{json.dumps(str(path))}]\ntrust_level = "trusted"\n'
                          for path in {temp, temp.resolve()}))
            native_args = ["--", "-C", str(temp), "--sandbox", "read-only", "-a", "never"]
            for key, value in {
                "sqlite_home": str(codex_home), "log_dir": str(codex_home),
                "features.apps": False, "features.plugins": False, "features.remote_plugin": False,
                "features.hooks": False, "features.memories": False, "features.shell_snapshot": False,
                "features.multi_agent": False, "features.skip_host_skill_discovery": True,
                "model_providers.fenjue.request_max_retries": 0, "model_providers.fenjue.stream_max_retries": 0,
                "features.unbounded_connection_retries": False, "tui.animations": False,
            }.items():
                native_args += ["-c", f"{key}={json.dumps(value)}"]
            terminal = Terminal(argv + native_args + ["Produce a long fixture response"], {
                **env, "CODEX_HOME": str(codex_home), "FENJUE_CODEX_BIN": str(native), "FENJUE_TEST_NATIVE_CODEX": codex,
            })
            try:
                terminal.until(lambda: terminal.contains("NATIVE_HISTORY_END"), "native Codex renders long answer", timeout=20)
                state = json.loads(state_file.read_text())
                assert terminal.pane_format(state["socket"], "#{alternate_on}") == "0", "Codex must preserve tmux history"
                terminal.check_scrollback(state["socket"], "NATIVE_HISTORY_START")
                terminal.check_mouse_copy(state["socket"], "NATIVE_HISTORY_END", temp / "copied-native.txt")
                terminal.send("\x1b[200~Continue after scrolling\x1b[201~")
                terminal.until(lambda: terminal.contains("Continue after scrolling"), "native composer accepts pasted text")
                terminal.send("\r")
                terminal.until(lambda: terminal.contains("NATIVE_CONTINUED"), "native input still works after scrolling")
                terminal.send("\x1b[200~/exit\x1b[201~")
                terminal.until(lambda: terminal.contains("/exit"), "native exit command entered")
                terminal.send("\r")
                assert terminal.wait() == 0
                assert not Path(state["socket"]).exists()
                checks.append("native Codex long answer + wheel scrollback + mouse copy + continued conversation")
            finally:
                terminal.close()

        print(json.dumps({"checks": checks, "localRequests": len(seen), "realModelCalls": 0}, ensure_ascii=False, indent=2))
finally:
    release_hold.set()
    server.shutdown()
    server.server_close()
    thread.join()
