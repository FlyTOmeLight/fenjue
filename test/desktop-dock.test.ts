import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { installDesktop } from "../src/desktop.js";
import { installDesktopDock, uninstallDesktopDock, type DockSystem } from "../src/desktop-dock.js";

const label = "io.github.flytomelight.fenjue.desktop-env";
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), "fenjue Dock 中文 & "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const launcher = join(home, "router 'a' <b> \"c\"");
  await writeFile(launcher, "#!/bin/sh\nexit 0\n");
  await chmod(launcher, 0o700);
  const agent = join(home, "Library/LaunchAgents", `${label}.plist`);
  const state = { current: "", registered: false, plistLauncher: launcher, failBootstrap: false };
  const calls: string[][] = [];
  const os: DockSystem = {
    platform: "darwin", home, uid: 501,
    async run(file, args) {
      calls.push([file, ...args]);
      if (file === "/usr/bin/plutil") return JSON.stringify({ Label: label, ProgramArguments: ["/bin/launchctl", "setenv", "CODEX_CLI_PATH", state.plistLauncher] });
      assert.equal(file, "/bin/launchctl");
      switch (args[0]) {
        case "getenv": return state.current ? state.current + "\n" : "";
        case "print": if (!state.registered) throw Object.assign(new Error("not found"), { code: 113 }); return "service";
        case "bootout": state.registered = false; return "";
        case "bootstrap":
          if (state.failBootstrap) { state.failBootstrap = false; throw new Error("bootstrap denied"); }
          state.registered = true; return "";
        case "setenv": state.current = args[2]!; return "";
        case "unsetenv": state.current = ""; return "";
        default: throw new Error(`Unexpected launchctl operation ${args[0]}`);
      }
    },
  };
  return { os, home, launcher, agent, state, calls };
}

test("Dock install registers a private agent and applies environment immediately; reinstall and uninstall are repeatable", async t => {
  const f = await fixture(t);
  assert.equal(await installDesktopDock(f.launcher, f.os), f.agent);
  assert.equal(f.state.current, f.launcher);
  assert.equal(f.state.registered, true);
  const text = await readFile(f.agent, "utf8");
  assert.ok(text.includes("&amp;") && text.includes("&apos;") && text.includes("&lt;") && text.includes("&quot;"));
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
  assert.equal((await stat(f.agent)).mode & 0o777, 0o600);
  if (process.platform === "darwin") {
    const { stdout } = await promisify(execFile)("/usr/bin/plutil", ["-convert", "json", "-o", "-", f.agent]);
    assert.deepEqual(JSON.parse(stdout).ProgramArguments, ["/bin/launchctl", "setenv", "CODEX_CLI_PATH", f.launcher]);
  }
  await installDesktopDock(f.launcher, f.os);
  assert.ok(f.calls.some(call => call[1] === "bootout"));
  await uninstallDesktopDock(f.os);
  assert.equal(f.state.registered, false);
  assert.equal(f.state.current, "");
  await assert.rejects(readFile(f.agent), { code: "ENOENT" });
  await stat(f.launcher); // Uninstall preserves the generated wrapper and its data.
  await uninstallDesktopDock(f.os);
});

test("Dock reinstall can move its own launcher but refuses to overwrite another GUI entry", async t => {
  const f = await fixture(t);
  await installDesktopDock(f.launcher, f.os);
  const next = join(f.home, "new-router");
  await writeFile(next, "#!/bin/sh\n"); await chmod(next, 0o700);
  await installDesktopDock(next, f.os);
  assert.equal(f.state.current, next);
  f.state.plistLauncher = next;
  f.state.current = "/another/tool";
  const contents = await readFile(f.agent, "utf8");
  f.calls.length = 0;
  await assert.rejects(installDesktopDock(next, f.os), /已有其他 CODEX_CLI_PATH/);
  assert.equal(await readFile(f.agent, "utf8"), contents);
  assert.equal(f.state.registered, true);
  assert.equal(f.calls.some(call => ["bootout", "bootstrap", "setenv"].includes(call[1]!)), false);
  assert.equal((await uninstallDesktopDock(f.os)).preservedEnvironment, true);
  assert.equal(f.state.current, "/another/tool");
});

for (const existing of [false, true]) test(`Dock installation restores prior file and GUI state on failure (existing=${existing})`, async t => {
  const f = await fixture(t);
  if (existing) await installDesktopDock(f.launcher, f.os);
  const previous = existing ? await readFile(f.agent, "utf8") : undefined;
  f.state.failBootstrap = true;
  await assert.rejects(installDesktopDock(f.launcher, f.os), /bootstrap denied/);
  assert.equal(f.state.registered, existing);
  assert.equal(f.state.current, existing ? f.launcher : "");
  if (previous) assert.equal(await readFile(f.agent, "utf8"), previous);
  else await assert.rejects(readFile(f.agent), { code: "ENOENT" });
});

test("Dock operations refuse non-macOS and propagate service query errors without mutation", async t => {
  const f = await fixture(t);
  for (const operation of [() => installDesktopDock(f.launcher, { ...f.os, platform: "linux" }), () => uninstallDesktopDock({ ...f.os, platform: "linux" })]) {
    await assert.rejects(operation(), /仅支持 macOS/);
  }
  const run = f.os.run;
  f.os.run = async (file, args) => {
    if (args[0] === "print") throw Object.assign(new Error("permission denied"), { code: 1 });
    return run(file, args);
  };
  await assert.rejects(installDesktopDock(f.launcher, f.os), /permission denied/);
  await assert.rejects(readFile(f.agent), { code: "ENOENT" });
});

test("Dock uninstall refuses a conflicting plist instead of deleting it", async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.agent), { recursive: true });
  await writeFile(f.agent, "unrelated");
  f.os.run = async () => JSON.stringify({ Label: "someone-else" });
  await assert.rejects(uninstallDesktopDock(f.os), /格式不匹配/);
  assert.equal(await readFile(f.agent, "utf8"), "unrelated");
});

for (const existing of [false, true]) test(`failed desktop install restores wrapper as well as agent (existing=${existing})`, async t => {
  const f = await fixture(t);
  const appPath = join(f.home, "ChatGPT.app");
  await mkdir(join(appPath, "Contents/MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents/MacOS/ChatGPT"), "");
  const logDir = join(f.home, "logs"), wrapper = join(logDir, "codex-desktop");
  if (existing) {
    await mkdir(logDir);
    await writeFile(wrapper, "original wrapper", { mode: 0o750 });
    await chmod(wrapper, 0o750);
  }
  f.state.failBootstrap = true;
  await assert.rejects(installDesktop({ configFile: "new-config.json", executable: f.launcher, appPath, logDir }, f.os), /bootstrap denied/);
  if (existing) {
    assert.equal(await readFile(wrapper, "utf8"), "original wrapper");
    assert.equal((await stat(wrapper)).mode & 0o777, 0o750);
  } else await assert.rejects(readFile(wrapper), { code: "ENOENT" });
});
