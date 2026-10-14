// Explicit paid probe: production gateway + configured Jev/Kev + native Codex.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { readConfig } from "../src/config.js";
import { startNativeGateway } from "../src/native-gateway.js";
import { NativeRecords, type NativeEvent } from "../src/native-records.js";
import { nativeArguments } from "../src/native-launcher.js";
import { validateNativeCatalog } from "../src/native-policy.js";
import type { NativeMessage } from "../src/native-session.js";
import { prepareDesktop } from "../src/desktop.js";
import { NativeAppServer } from "./native-app-server.js";

const args = process.argv.slice(2), flags = new Map<string, string>();
const desktop = args.includes("--desktop");
if (desktop) args.splice(args.indexOf("--desktop"), 1);
while (args.length) { const key = args.shift()!, value = args.shift(); assert.ok(["--config", "--env-file"].includes(key) && value); flags.set(key, value); }
const config = await readConfig(resolve(flags.get("--config") ?? "fenjue.config.json"));
assert.equal(config.auth, "chatgpt"); assert.ok(config.semantic);
config.semantic.mode = "auto"; config.native = { expertModel: "gpt-6-astra" };
if (desktop) delete config.capture;
const key = config.semantic.apiKeyEnv;
if (flags.has("--env-file")) {
  assert.ok(key); const value = parseEnv(await readFile(flags.get("--env-file")!, "utf8"))[key];
  assert.ok(value, "Configured classifier key is absent"); process.env[key] = value;
}
const executable = process.env.FENJUE_CODEX_BIN ?? (desktop ? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" : "codex"), exec = promisify(execFile);
const version = (await exec(executable, ["--version"])).stdout.trim();
validateNativeCatalog(JSON.parse((await exec(executable, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024 })).stdout), config);
const temp = await mkdtemp(join(tmpdir(), "fenjue-live-router-"));
const directory = resolve(".fenjue/verification", `${desktop ? "desktop" : "native-router"}-live-${Date.now()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const records = desktop ? undefined : new NativeRecords(directory, join(directory, "capture"), key ? [process.env[key] ?? ""] : [], message => { throw new Error(message); });
const events: NativeEvent[] = [], turns: unknown[] = [];
let messages: NativeMessage[] = [], desktopClient: NativeAppServer | undefined;
let gateway: Awaited<ReturnType<typeof startNativeGateway>> | undefined, ws: WebSocket | undefined, threadId: string | undefined, failure: Error | undefined;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
let sequence = 0;
const request = (method: string, params: any): Promise<any> => desktopClient ? desktopClient.request(method, params, 45_000) : new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 45_000);
  pending.set(id, { resolve, reject, timer }); ws!.send(JSON.stringify({ id, method, params }));
});
try {
  const settings = { "features.apps": false, "features.plugins": false, "features.remote_plugin": false, "features.hooks": false,
    "features.memories": false, "features.shell_snapshot": false, "features.multi_agent": false, "features.skip_host_skill_discovery": true };
  const overrides = Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]);
  const serverArgs = nativeArguments(config, overrides).server;
  const env = { ...process.env }; if (key && key !== "OPENAI_API_KEY") delete env[key];
  const socket = join(temp, "app.sock");
  const observers = { onEvent: (event: NativeEvent) => { events.push(event); }, onFailure: (error: Error) => { failure = error; } };
  if (desktop) {
    const configFile = join(temp, "desktop.json");
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    const entry = await prepareDesktop({ executable, configFile, envFile: flags.get("--env-file"), logDir: directory });
    desktopClient = new NativeAppServer(entry.launcher, ["-c", "features.code_mode_host=true", "app-server", ...overrides], process.env);
    messages = desktopClient.messages;
    await desktopClient.initialize();
  } else {
  gateway = await startNativeGateway({ socket, executable, serverArgs, env, config, records: records!, ...observers });
  ws = new WebSocket(`ws+unix://${socket}:/`);
  ws.on("message", data => {
    const message = JSON.parse(data.toString()); messages.push(message);
    if (message.id !== undefined && !message.method) {
      const job = pending.get(message.id); if (!job) return;
      pending.delete(message.id); clearTimeout(job.timer);
      if (message.error) job.reject(new Error(JSON.stringify(message.error))); else job.resolve(message.result);
    } else if (message.id !== undefined) {
      ws!.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Probe has no interactive approval UI" } }));
    }
  });
  await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
  await request("initialize", { clientInfo: { name: "fenjue_live_probe", version: "0.2.0" }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: "initialized" }));
  }
  const thread = await request("thread/start", { threadSource: "user", cwd: temp, sandbox: "read-only", approvalPolicy: "never", ephemeral: false });
  threadId = thread.thread.id;
  for (const text of [
    "把字符串 fenjue 改成大写，只返回结果，不调用工具。",
    "[new] 请为订单服务、支付服务、库存服务三个独立系统比较至少两种跨服务一致性架构，权衡重复回调、乱序事件和补偿失败；约束是不得共享数据库。只用中文 120 字以内总结方案取舍，不调用工具。",
  ]) {
    const cursor = messages.length, started = Date.now();
    const result = await request("turn/start", { threadId, input: [{ type: "text", text }], model: "gpt-6.1-sol", effort: "medium",
      collaborationMode: { mode: "default", settings: { model: "gpt-6.1-sol", reasoning_effort: "medium", developer_instructions: null } } });
    const turnId = result.turn.id;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(timer); reject(new Error("Turn completion timeout")); }, 120_000);
      const timer = setInterval(() => {
        const done = messages.slice(cursor).find(m => m.method === "turn/completed" && m.params.turn.id === turnId);
        if (failure || done) {
          clearTimeout(deadline); clearInterval(timer);
          if (failure) reject(failure);
          else if (done!.params.turn.status !== "completed") reject(new Error(JSON.stringify(done!.params.turn)));
          else resolve();
        }
      }, 50);
    });
    if (desktop) {
      const names = (await readdir(directory)).filter(name => /^native-.*\.jsonl$/.test(name));
      events.splice(0, events.length, ...(await Promise.all(names.map(name => readFile(join(directory, name), "utf8"))))
        .flatMap(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))));
    }
    const decision = events.find(e => e.type === "accepted" && e.turnId === turnId)!;
    assert.equal(decision.reason, "classified", "Real classifier must take over, not hold a fallback");
    const final = events.find(e => e.type === "final-answer" && e.turnId === turnId); assert.ok(final);
    const turn = { turnId, route: decision.route, status: "completed", elapsedMs: Date.now() - started, finalAnswerCaptured: true };
    turns.push(turn); console.log(JSON.stringify(turn));
  }
  assert.deepEqual((turns as any[]).map(t => t.route), [{ model: "gpt-6.1-sol", effort: "low" }, { model: "gpt-6-astra", effort: "high" }]);
  await writeFile(join(directory, "report.json"), JSON.stringify({ passed: true, backend: version, desktopTransport: desktop ? "stdio-wrapper" : false, guiTested: false,
    modelTurnBudget: 2, classifier: config.semantic.model,
    realModelTurns: turns.length, turns, note: "Connectivity and classification takeover probe, not a task-quality benchmark" }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, report: join(directory, "report.json") }));
} finally {
  if (threadId && (desktopClient || ws?.readyState === WebSocket.OPEN)) await request("thread/archive", { threadId }).catch(() => {});
  for (const job of pending.values()) clearTimeout(job.timer);
  ws?.terminate(); await desktopClient?.close(); await gateway?.close();
  if (desktop) await rm(join(directory, "codex-desktop"), { force: true });
  await rm(temp, { recursive: true, force: true });
}
