import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktop } from "../src/desktop.js";
import { NativeAppServer } from "../scripts/native-app-server.js";
import { models, semanticConfig } from "./fixtures.js";

for (const shutdown of ["stdin", "SIGTERM"] as const) test(`desktop launcher execs backend in place and cleans up routing after ${shutdown}`, { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "fenjue-desktop-launcher-"));
  const executable = join(root, "backend.mjs"), catalog = join(root, "models.json");
  const configFile = join(root, "fenjue.json"), logDir = join(root, "logs");
  await writeFile(executable, `#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
const identity = () => ({ pid: process.pid, ppid: process.ppid, argv: process.argv.slice(2), toolsPipe: process.env.CODEX_APP_TOOLS_PIPE_PATH });
if (process.argv.includes('--version')) process.stdout.write(JSON.stringify(identity()) + '\\n');
// On macOS Node wraps FIFO stdin as a Socket which does not emit EOF.
else createInterface({ input: createReadStream('', { fd: 0 }) }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: identity() }) + '\\n');
});
`);
  await chmod(executable, 0o700);
  await writeFile(catalog, JSON.stringify(models()));
  const config = semanticConfig();
  config.routes.deep = { model: "fixture-fast", effort: "high" };
  config.catalog = catalog;
  await writeFile(configFile, JSON.stringify(config));
  const appPath = join(root, "fixture.app");
  await mkdir(join(appPath, "Contents/MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents/MacOS/ChatGPT"), "");
  const { launcher } = await prepareDesktop({ appPath, executable, configFile, logDir });
  const toolsPipe = join(root, "untouched-app-tools.sock");
  const env = { ...process.env, TYPESAFE_API_KEY: "classifier-key-not-used", CODEX_APP_TOOLS_PIPE_PATH: toolsPipe };
  const appArgs = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", 'mcp_servers.app_tools.command="/test/App Tools"'];
  const client = new NativeAppServer(launcher, appArgs, env);
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  const identity = await client.request("initialize", { clientInfo: { name: "desktop-regression", version: "1" } });
  const controlPath = join(logDir, `desktop-${client.child.pid}.json`);
  const control = JSON.parse(await readFile(controlPath, "utf8"));
  assert.equal(identity.pid, client.child.pid, "App-spawned launcher PID must become the backend PID");
  assert.equal(identity.ppid, process.pid, "Backend must remain a direct child, without a Node router ancestor");
  assert.equal(control.pid, client.child.pid, "Control record must identify the App-spawned backend");
  assert.equal(typeof control.sidecarPid, "number", "Control record must identify routing sidecar for lifecycle checks");
  assert.equal(identity.toolsPipe, toolsPipe);
  assert.deepEqual(identity.argv.slice(0, 3), appArgs.slice(0, 3), "Global App options must stay before app-server");
  assert.deepEqual(identity.argv.slice(-3), appArgs.slice(-3), "App service options must stay last, including spaces");
  assert.ok(identity.argv.includes('model_provider="fenjue_native_fixture"'), "Routing provider defaults must reach backend");

  const exited = once(client.child, "close");
  if (shutdown === "stdin") client.child.stdin.end();
  else client.child.kill(shutdown);
  const [code, signal] = await exited;
  assert.equal(code, shutdown === "stdin" ? 0 : null, client.stderr);
  assert.equal(signal, shutdown === "stdin" ? null : shutdown);
  const deadline = Date.now() + 2000;
  while (true) {
    try { await readFile(controlPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    assert.ok(Date.now() < deadline, "Sidecar must remove control file after backend exits");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await assert.rejects(readFile(control.socket), { code: "ENOENT" }, "Sidecar must remove its Unix control socket");
  while (true) {
    try { process.kill(control.sidecarPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
    assert.ok(Date.now() < deadline, "Routing sidecar must exit with backend");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
});

test("desktop launcher passes non-server commands through without inserting a parent", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "fenjue-desktop-version-"));
  const executable = join(root, "backend.mjs"), configFile = join(root, "unused.json");
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv.slice(2) }) + '\\n');
`);
  await chmod(executable, 0o700);
  const appPath = join(root, "fixture.app");
  await mkdir(join(appPath, "Contents/MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents/MacOS/ChatGPT"), "");
  const { launcher } = await prepareDesktop({ appPath, executable, configFile, logDir: root });
  const child = spawn(launcher, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); });
  let output = "", stderr = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { stderr += data; });
  const [code] = await once(child, "close"), identity = JSON.parse(output);
  assert.equal(code, 0, stderr);
  assert.equal(identity.pid, child.pid, "Passthrough must replace launcher with backend");
  assert.equal(identity.ppid, process.pid);
  assert.deepEqual(identity.argv, ["--version"]);
});
