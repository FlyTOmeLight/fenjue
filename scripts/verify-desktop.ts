import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseConfig } from "../src/config.js";
import { prepareDesktop } from "../src/desktop.js";
import { nativeControl } from "../src/native-control.js";
import { NativeAppServer } from "./native-app-server.js";
import { classification, jevResponse, readJSON, serve } from "../test/fixtures.js";

// Exercises the production desktop entry with the App's actual backend, while
// both classifier and model endpoints stay on loopback. It does not drive GUI.
const executable = process.env.FENJUE_CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), "fenjue-desktop-"));
const testHome = join(root, "codex-home");
await mkdir(testHome);
const env = { ...process.env, CODEX_HOME: testHome, OPENAI_API_KEY: undefined };
const seen: { model: string; effort: string }[] = [];
let classificationCalls = 0;
const upstream = await serve(async (req, res) => {
  const body = await readJSON(req);
  if (req.url === "/classify") {
    classificationCalls++;
    const expert = body.state.newMessages.join(" ").includes("跨服务");
    const result = classification(expert ? { scope: "cross_system", reasoning: "architecture" } : {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...jevResponse(result), model: "kev-latest" })); return;
  }
  assert.equal(req.url, "/responses");
  seen.push({ model: body.model, effort: body.reasoning?.effort });
  const item = { type: "message", id: `msg_${seen.length}`, role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text: "DESKTOP_OK", annotations: [] }] };
  const response = { id: `resp_${seen.length}`, object: "response", status: "completed", model: body.model, output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "DESKTOP_OK" },
    { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
});
let client: NativeAppServer | undefined;
try {
  const version = (await exec(executable, ["--version"], { env })).stdout.trim();
  const catalog = join(root, "models.json");
  await writeFile(catalog, (await exec(executable, ["debug", "models", "--bundled"], { env, maxBuffer: 16 * 1024 * 1024 })).stdout);
  const config = parseConfig({ version: 1, auth: "mock", upstream: upstream.url, catalog, defaultRoute: "balanced", rules: [],
    routes: Object.fromEntries(["low", "medium", "high"].map((effort, i) => [["fast", "balanced", "deep"][i], { model: "gpt-6.1-sol", effort }])),
    native: { expertModel: "gpt-6-astra" },
    semantic: { provider: "kev", model: "kev-latest", endpoint: upstream.url + "/classify", mode: "auto", roles: { fast: "fast", balanced: "balanced", deep: "deep" } },
  });
  const configFile = join(root, "fenjue.json"), logDir = join(root, "logs");
  await writeFile(configFile, JSON.stringify(config));
  const { launcher } = await prepareDesktop({ configFile, executable, logDir });
  assert.equal((await exec(launcher, ["--version"], { env })).stdout.trim(), version, "Non-server commands must pass through unchanged");
  client = new NativeAppServer(launcher, ["-c", "features.code_mode_host=true", "app-server",
    "-c", `sqlite_home=${JSON.stringify(root)}`, "-c", `log_dir=${JSON.stringify(root)}`,
    ...["apps", "plugins", "remote_plugin", "hooks", "memories", "shell_snapshot", "multi_agent"].flatMap(f => ["-c", `features.${f}=false`]),
    "-c", "features.skip_host_skill_discovery=true",
  ], env);
  await client.initialize();
  const controlPath = join(logDir, `desktop-${client.child.pid}.json`);
  const control = JSON.parse(await readFile(controlPath, "utf8"));
  const started = await client.request("thread/start", { cwd: root, threadSource: "user", model: "gpt-6.1-sol", approvalPolicy: "never", sandbox: "read-only" });
  assert.equal(started.modelProvider, "fenjue_native_fixture", "Launcher must apply mock provider settings before any model request");
  const thread = started.thread;
  async function turn(text: string) {
    const offset = client!.messages.length;
    const result = await client!.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }], model: "gpt-6.1-sol", effort: "medium",
      collaborationMode: { mode: "default", settings: { model: "gpt-6.1-sol", reasoning_effort: "medium", developer_instructions: null } } });
    const completed = await client!.waitFor(m => m.method === "turn/completed" && m.params.turn.id === result.turn.id, offset, 15_000);
    assert.equal(completed.params.turn.status, "completed");
  }
  await turn("[new] 将这三个词按字母排序：pear apple banana。");
  await turn("[new] 分析跨服务事务的一致性与故障恢复架构。");
  assert.deepEqual(seen, [{ model: "gpt-6.1-sol", effort: "low" }, { model: "gpt-6-astra", effort: "high" }]);
  assert.equal(classificationCalls, 2, "Both choices must come from classification, not prefix model rules");
  await client.request("thread/settings/update", { threadId: thread.id, model: "gpt-6.1-sol", effort: "medium" });
  await turn("[new] 分析跨服务事务的一致性与故障恢复架构。");
  assert.equal(classificationCalls, 2, "Manual mode must not call classifier");
  assert.deepEqual(seen.at(-1), { model: "gpt-6.1-sol", effort: "medium" });
  await nativeControl(control.socket, "auto");
  await turn("[new] 分析跨服务事务的一致性与故障恢复架构。");
  assert.deepEqual(seen.at(-1), { model: "gpt-6-astra", effort: "high" });
  assert.equal(classificationCalls, 3, "Returning to auto must restore classification");
  const logs = (await readFile(control.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(logs.some(e => e.type === "planned" && e.reason === "classified" && e.route.model === "gpt-6-astra"));
  assert.deepEqual(upstream.errors, []);
  await client.close();
  assert.equal(client.child.exitCode, 0, "Launcher must shut down cleanly");
  client = undefined;
  await assert.rejects(readFile(controlPath), { code: "ENOENT" }, "Launcher shutdown must remove its control file");
  await assert.rejects(readFile(control.socket), { code: "ENOENT" }, "Launcher shutdown must remove its socket");
  console.log(JSON.stringify({ passed: true, backend: version, guiTested: false, realModelCalls: 0, classificationCalls,
    requests: seen, checks: ["desktop stdio launcher", "non-server command passthrough", "App-style global flags and turn parameters", "automatic Sol/Astra selection", "manual picker override", "Unix control returns to auto", "route receipts", "control file and socket cleanup"] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ classificationCalls, requests: seen, backendStderr: client?.stderr,
    recentEvents: client?.messages.slice(-12).map(m => ({ id: m.id, method: m.method, turn: m.params?.turn && { id: m.params.turn.id, status: m.params.turn.status }, error: m.params?.error })) }, null, 2));
  throw error;
} finally {
  await client?.close(); await upstream.close(); await rm(root, { recursive: true, force: true });
}
