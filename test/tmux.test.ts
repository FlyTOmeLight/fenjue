import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createTmuxDisplay, interactiveCodex, startTmuxSession } from "../src/tmux.js";

const exec = promisify(execFile);
let tmux = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 }); } catch { tmux = false; }

test("only interactive Codex commands enter the status-bar terminal", () => {
  for (const args of [[], ["修复这个问题"], ["resume", "--last"], ["fork"], ["-C", "/tmp/project"],
    ["--", "exec"], ["-c", "model=custom", "解释这段代码"]]) assert.equal(interactiveCodex(args), true, JSON.stringify(args));
  for (const args of [["exec", "--json", "hello"], ["-C", "/tmp/project", "exec", "hello"],
    ["review"], ["--help"], ["--version"], ["login"], ["debug", "models"], ["-m", "test", "e", "hello"]]) {
    assert.equal(interactiveCodex(args), false, JSON.stringify(args));
  }
});

test("tmux isolates sessions, preserves argv, renders literal route data, and cleans up its server", { skip: !tmux, timeout: 15_000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-tmux-test-"));
  const sessions: Awaited<ReturnType<typeof startTmuxSession>>[] = [];
  t.after(async () => { try { for (const s of sessions) await s.close(); } finally { await rm(temp, { recursive: true, force: true }); } });
  const script = join(temp, "pane.mjs"), argvFile = join(temp, "observed.json"), marker = join(temp, "injected");
  await writeFile(script, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); setInterval(() => {}, 1000);');
  const args = ["中文🙂", ";", "trailing;", "$(touch unwanted)", "`literal`", "a space"];
  const first = await startTmuxSession([script, argvFile, ...args]); sessions.push(first);
  const second = await startTmuxSession([script, join(temp, "other.json")]); sessions.push(second);
  const deadline = Date.now() + 3000;
  while (!(await access(argvFile).then(() => true, () => false))) {
    if (Date.now() >= deadline) assert.fail("Pane did not start");
    await delay(10);
  }
  assert.deepEqual(JSON.parse(await readFile(argvFile, "utf8")), args);
  const command = (socket: string, ...args: string[]) => exec("tmux", ["-S", socket, ...args]);
  const model = `fixture#(touch ${marker})#[fg=red]%H`;
  const display = createTmuxDisplay(first.socket);
  display.onEvent({ event: "request", request: 1, model: "old", effort: "low" });
  display.onEvent({ event: "request", request: 2, model, effort: "high", route: "deep" });
  display.onEvent({ event: "completed", request: 1, status: 200, servedModel: "old" });
  await display.close();
  const rendered = (await command(first.socket, "display-message", "-p", "-t", "fenjue:0.0", "#{T:status-format[0]}")).stdout;
  // display-message expands formats but leaves the escaped style marker for
  // the status renderer's subsequent style pass.
  assert.ok(rendered.includes(model.replace("#[", "##[")), rendered);
  assert.match(rendered, /high.*deep.*已发出/);
  assert.doesNotMatch(rendered, /请求 old|上游 old/);
  await assert.rejects(access(marker));
  const other = (await command(second.socket, "show-options", "-gv", "status-format[0]")).stdout;
  assert.match(other, /等待模型请求/);
  assert.equal((await command(first.socket, "show-options", "-gv", "prefix")).stdout.trim(), "None");
  await first.close();
  await assert.rejects(access(first.socket));
  await command(second.socket, "has-session", "-t", "fenjue");
});
