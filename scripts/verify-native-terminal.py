"""Offline native App Server TUI acceptance using the installed Codex CLI."""
import errno
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import sys

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
assert NODE and shutil.which("tmux"), "Install Node.js and tmux first"
seen = []
native_requests = 0
auxiliary_requests = 0
router_mode = "--router" in sys.argv
classifications = []

class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        global native_requests, auxiliary_requests
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/v1/systemone":
            classifications.append(body["state"])
            text = body["state"]["newMessages"][-1]
            features = {"relation": "new", "scope": "local", "reasoning": "mechanical", "uncertainty": "sufficient", "consequence": "reversible"}
            if "Summarize the previous answer" in text:
                features.update(relation="continue")
            if "bounded feature" in text:
                features.update(reasoning="solution")
            if "cross-system" in text:
                features.update(scope="cross_system", reasoning="diagnosis", uncertainty="unknown_cause")
            reply = json.dumps({"model": body["model"], "usage": {"input_tokens": 100}, "answers": {
                key: {"type": "choice", "choice": choice, "confidence": 1.0,
                      "probabilities": {option: float(option == choice) for option in body["questions"][key]["criteria"]}}
                for key, choice in features.items()}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)
            return
        structured = body.get("text", {}).get("format", {}).get("type") == "json_schema"
        if not structured:
            if router_mode and not seen:
                state = json.loads(native_state.read_text())
                manifests = list(Path(state["executionCases"]).glob("daily-*/capture.json"))
                assert len(manifests) == 1, "Starting snapshot must exist before first model request"
                assert json.loads(manifests[0].read_text())["prompts"] == ["Implement a bounded feature"], "Accepted input must enter its starting snapshot once"
                assert (manifests[0].parent / "snapshot/source/code.txt").read_text() == "before"
            seen.append((body["model"], body["reasoning"]["effort"]))
        else:
            auxiliary_requests += 1
        if body.get("stream"):
            if not structured:
                native_requests += 1
            text = ("```\nNATIVE_HISTORY_START\n" + "\n".join(f"NATIVE_LINE_{i}" for i in range(180))
                    + "\nNATIVE_HISTORY_END\n```") if native_requests == 1 else "NATIVE_CONTINUED"
            if structured:
                schema = body["text"]["format"].get("schema", {})
                text = json.dumps({key: "Native fixture" for key in schema.get("properties", {})})
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

    def check_scrollback(self, socket, marker):
        assert int(self.pane_format(socket, "#{history_size}")) >= 150, "Response must overflow the viewport"
        live = subprocess.check_output(["tmux", "-S", socket, "capture-pane", "-p", "-t", "fenjue:0.0"], text=True)
        assert marker not in live, "Old marker must be above the live viewport"
        before = len(self.output)
        # Check the actual repaint after SGR wheel events: capture-pane can
        # return the underlying live screen even while copy-mode is visible.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.send("\x1b[<64;10;10M")
            self.read()
            if marker.encode() in self.output[before:]:
                break
        assert marker.encode() in self.output[before:], "Wheel scrolling must reveal the old response marker"
        assert self.pane_format(socket, "#{pane_in_mode}") == "1"
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
    with tempfile.TemporaryDirectory(prefix="fenjue-native-pty-") as directory:
        temp = Path(directory)
        checks = []
        codex = os.environ.get("FENJUE_CODEX_BIN") or shutil.which("codex")
        assert codex, "Install Codex CLI for native terminal verification"
        native_requests = 0
        native_state = temp / "native-app-server.json"
        fixture = "native-router-fixture.js" if router_mode else "native-terminal-fixture.js"
        terminal = Terminal([str(ROOT / "dist/scripts" / fixture), str(native_state),
                             f"http://127.0.0.1:{server.server_port}"], {
            "PATH": os.environ["PATH"], "LANG": "en_US.UTF-8", "TERM": "xterm-256color",
            "FENJUE_CODEX_BIN": codex,
        })

        def app_state():
            state = json.loads(native_state.read_text()) if native_state.exists() else {}
            if router_mode and state:
                events = []
                for log in sorted(Path(state["logDir"]).glob("native-*.jsonl")):
                    events.extend(json.loads(line) for line in log.read_text().splitlines() if line)
                state.update(trace=events, mainThreadId=next((e["threadId"] for e in events if e["type"] == "bound"), None),
                             completed=[e for e in events if e["type"] == "completed"],
                             routes=[e["route"] for e in events if e["type"] == "accepted" and e["mode"] == "auto"])
            return state

        def completed_turns():
            state = app_state()
            return [turn for turn in state.get("completed", []) if turn["threadId"] == state.get("mainThreadId")]

        def enter(text):
            before = len(terminal.output)
            terminal.send("\x1b[200~" + text + "\x1b[201~")
            terminal.until(lambda: text.encode() in terminal.output[before:], "remote TUI composer accepts input")
            terminal.send("\r")

        try:
            terminal.until(lambda: terminal.contains("NATIVE_HISTORY_END"), "remote TUI renders native response", timeout=20)
            state = app_state()
            assert seen[-1] == ("gpt-6.1-sol", "medium")
            assert terminal.pane_format(state["socket"], "#{alternate_on}") == "0"
            terminal.check_scrollback(state["socket"], "NATIVE_HISTORY_START")
            for index, (model, effort) in enumerate([("astra", "high"), ("sol", "low")], start=2):
                before = len(terminal.output)
                enter(("Diagnose an unknown cross-system failure" if model == "astra" else "Summarize the previous answer into three bullets")
                      if router_mode else f"FENJUE_NATIVE_ROUTE {model} {effort}")
                terminal.until(lambda: len(completed_turns()) >= index, "remote routed turn completes")
                assert seen[-1] == ("gpt-6-astra" if model == "astra" else "gpt-6.1-sol", effort)
                label = ("GPT-6-Astra" if model == "astra" else "GPT-6.1-Sol") + " " + effort
                terminal.until(lambda: label.encode() in terminal.output[before:], "native footer reflects routed model and effort")
            checks.append("native App Server TUI Sol/Astra/Sol + wheel scrollback")
            if router_mode:
                checks.append("same-task summary lowers Astra/high to Sol/low without a new-task marker")
            checks.append("native footer follows model and effort updates")
            assert not any(m.get("direction") == "client" and m.get("method") == "thread/settings/update"
                           for m in app_state()["trace"]), "Automatic turn feedback must not look like a manual selection"
            enter("/model")
            terminal.until(lambda: terminal.contains("Select Model and Effort"), "native model picker")
            # The fixture catalog contains the native default Sol and Astra.
            terminal.send("2")
            terminal.until(lambda: terminal.contains("Select Reasoning"), "native effort picker")
            terminal.send("2")
            terminal.until(lambda: any((m.get("type") == "mode" and m.get("mode") == "manual") if router_mode else
                                      (m.get("direction") == "client" and m.get("method") == "thread/settings/update"
                                       and m.get("model") == "gpt-6-astra") for m in app_state().get("trace", [])), "manual model setting event")
            classified_before_manual = len(classifications)
            enter("Continue with my manually selected model")
            terminal.until(lambda: len(completed_turns()) >= 4, "manual turn completes")
            assert seen[-1] == ("gpt-6-astra", "medium")
            checks.append("native /model produces explicit settings event and subsequent manual route")
            if router_mode:
                assert len(classifications) == classified_before_manual, "Manual route must not call classifier"
                terminal.send("\x1b[19~")  # F8 opens tmux control menu.
                terminal.until(lambda: terminal.contains("固定当前选择"), "F8 routing menu")
                terminal.send("a")
                terminal.until(lambda: any(e.get("type") == "mode" and e.get("mode") == "auto"
                                          for e in app_state()["trace"]), "menu restores automatic mode")
                enter("Uppercase xyz")
                terminal.until(lambda: len(completed_turns()) >= 5, "automatic turn after manual override")
                assert seen[-1] == ("gpt-6.1-sol", "low")
                assert len(classifications) > classified_before_manual
                checks.append("production HTTP classifier, manual pause and F8 resume auto")
            trace = app_state()
            title_threads = [m for m in trace["trace"] if m.get("direction") == "client" and m.get("method") == "thread/start"
                             and m.get("threadSource") == "thread_title"]
            if router_mode:
                assert len(trace["routes"]) == 4
                assert len([e for e in trace["trace"] if e["type"] == "bound"]) == 1, "Title thread must not bind"
                finals = [e for e in trace["trace"] if e["type"] == "final-answer"]
                assert len(finals) == 5, "Every final answer must be recorded without a subsequent prompt"
                frames = [json.loads(line) for file in Path(trace["capture"]).glob("capture-*.jsonl") for line in file.read_text().splitlines()]
                users = [item for frame in frames for item in frame["items"] if item["kind"] == "user"]
                assert len(users) == 5, "Initial input must not be captured twice"
                assert all("/model" not in item["text"] for item in users)
                checks.append("five foreground inputs and final answers captured, no control commands or title cases")
                manifests = list(Path(trace["executionCases"]).glob("daily-*/capture.json"))
                captures = [json.loads(path.read_text()) for path in manifests]
                assert sum(len(c["prompts"]) for c in captures) == 5
                assert all(c["contextComplete"] and all(turn in c["outcomes"] for turn in c["turnIds"]) for c in captures)
                assert all((p.parent / "snapshot/source/code.txt").read_text() == "before" for p in manifests)
                checks.append("production launcher saves execution snapshots before model requests and associates accepted turns")
            else:
                assert title_threads and all(m.get("ephemeral") for m in title_threads)
                assert len(trace["routes"]) == 3, "Title generation must not be routed as a user task"
            assert all(turn["status"] == "completed" for turn in completed_turns())
            checks.append("ephemeral title thread is distinguishable from foreground user turns")
            if router_mode:
                enter("[new] Diagnose an unknown cross-system failure")
                terminal.until(lambda: len(completed_turns()) >= 6, "prepare expert route for resume")
                terminal.send("\x1b[19~")
                terminal.read()
                terminal.send("m")
                terminal.until(lambda: app_state()["trace"][-1].get("mode") == "manual", "manual mode before restart")
                before_resume = len(classifications)
                enter("/exit")
                terminal.until(lambda: app_state().get("phase") == 2, "launcher restarts with resume")
                terminal.until(lambda: terminal.contains("1 / 1 · 100%"), "resume picker loads saved session")
                terminal.send("\r")
                terminal.until(lambda: len([e for e in app_state()["trace"] if e["type"] == "bound"]) == 2, "native resumed thread binds", timeout=20)
                assert [e for e in app_state()["trace"] if e["type"] == "bound"][-1]["reason"] == "ready", "Saved task cursor must reconcile with native history"
                enter("继续")
                terminal.until(lambda: len(completed_turns()) >= 7, "resumed manual turn completes")
                assert seen[-1] == ("gpt-6-astra", "high"), "Resume must preserve manual model and effort"
                assert len(classifications) == before_resume
                checks.append("real TUI resume picker reconnects and preserves manual mode and Astra/high")
                captures = [json.loads(p.read_text()) for p in Path(app_state()["executionCases"]).glob("daily-*/capture.json")]
                assert sum(len(c["prompts"]) for c in captures) == 7, "Resume must append to existing execution case"
                checks.append("execution case preserves its initial snapshot and appends resumed task input")
                enter("/exit")
                terminal.until(lambda: app_state().get("phase") == 3 and len(seen) >= 8, "legacy virtual-model session starts", timeout=20)
                enter("/exit")
                terminal.until(lambda: app_state().get("phase") == 4, "resume legacy session through native gateway")
                terminal.until(lambda: len([e for e in app_state()["trace"] if e["type"] == "bound"]) == 3,
                               "legacy native resume binds", timeout=20)
                before_legacy_continue = len(classifications)
                enter("继续")
                terminal.until(lambda: len(seen) >= 9, "legacy continuation executes")
                terminal.until(lambda: len([e for e in app_state()["trace"] if e["type"] == "completed"]) >= 8, "legacy continuation completes")
                assert seen[-1] == ("gpt-6.1-sol", "high"), "Unknown legacy context must preserve a conservative concrete route"
                assert len(classifications) == before_legacy_continue
                assert any(e["type"] == "legacy-resume" for e in app_state()["trace"])
                checks.append("legacy fenjue-auto thread resumes under concrete native Sol/high with unknown context")
                trace = app_state()
                captures = [json.loads(p.read_text()) for p in Path(trace["executionCases"]).glob("daily-*/capture.json")]
                assert sum(len(c["prompts"]) for c in captures) == 7, "Unknown legacy start cannot fabricate an execution snapshot"
                classified_before_natural = len(classifications)
                enter("Diagnose an unknown cross-system failure")
                terminal.until(lambda: len(seen) >= 10 and len([e for e in app_state()["trace"] if e["type"] == "completed"]) >= 9,
                               "legacy resume naturally switches to Astra")
                assert seen[-1] == ("gpt-6-astra", "high")
                assert len(classifications) > classified_before_natural
                assert [e for e in app_state()["trace"] if e["type"] == "accepted"][-1]["reason"] == "classified"
                checks.append("legacy resume recovers history and routes an independent request without a new-task marker")
                trace = app_state()
            enter("/exit")
            assert terminal.wait() == 0
            assert not Path(trace["socket"]).exists()
            assert not Path(trace["temp"]).exists()
            report = ROOT / ".fenjue/verification" / f"native-{'router' if router_mode else 'terminal'}-{time.time_ns()}"
            report.mkdir(parents=True, mode=0o700)
            (report / "report.json").write_text(json.dumps({"passed": True, "checks": checks,
                "routes": trace["routes"], "trace": trace["trace"], "foregroundRequests": len(seen),
                "auxiliaryRequests": auxiliary_requests, "realModelCalls": 0}, ensure_ascii=False, indent=2))
            (report / "report.json").chmod(0o600)
        except Exception:
            print("Native App Server state:", json.dumps(app_state(), ensure_ascii=False)[-6000:], file=sys.stderr)
            raise
        finally:
            terminal.close()


        print(json.dumps({"checks": checks, "localRequests": len(seen) + auxiliary_requests,
                          "foregroundRequests": len(seen), "auxiliaryRequests": auxiliary_requests,
                          "realModelCalls": 0, "report": str(report / "report.json")}, ensure_ascii=False, indent=2))
finally:
    server.shutdown()
    server.server_close()
    thread.join()
