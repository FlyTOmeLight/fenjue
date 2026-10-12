"""PTY driver for offline server-initiated turns (review or capacity retry)."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

codex, socket, cwd, home = sys.argv[1:5]
prompt, first_answer, next_answer = sys.argv[5:] or [
    "Fix result.txt to contain fixed and test the result.", "AUTO_REVIEW_FIXED", "AFTER_AUTO_REVIEW"]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    env = {**os.environ, "CODEX_HOME": home, "TERM": "xterm-256color"}
    os.execvpe(codex, [codex, "--remote", "unix://" + socket, "--no-alt-screen", "-s", "workspace-write", "-a", "never",
                      prompt], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
output = bytearray()

def until(text, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([fd], [], [], .05)[0]:
            try:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                output.extend(chunk)
            except OSError as e:
                if e.errno == errno.EIO:
                    break
                raise
        if text.encode() in output:
            return
        # A fresh, isolated CODEX_HOME may ask whether to trust this directory.
        if b"trust" in output[-1500:].lower() and b"enter" in output[-1500:].lower():
            os.write(fd, b"\r")
    raise RuntimeError("TUI did not show " + text + ": " + output[-10000:].decode(errors="replace"))

try:
    until(first_answer)
    os.write(fd, b"Describe the resulting file in one sentence.")
    time.sleep(.2)
    os.write(fd, b"\r")
    until(next_answer)
    print("TUI displayed the automatic turn and accepted the next user request.", flush=True)
    time.sleep(.2)
    os.write(fd, b"/exit\r")
finally:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if select.select([fd], [], [], .05)[0]:
            try:
                os.read(fd, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
        if os.waitpid(pid, os.WNOHANG)[0]:
            break
        time.sleep(.05)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    os.close(fd)
