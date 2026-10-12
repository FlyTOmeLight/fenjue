// Offline acceptance fixture: real Codex TUI -> local WebSocket/stdio relay ->
// real App Server -> mock Responses endpoint. Route markers are test inputs,
// not a production classifier or a supported user command.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { writeFileSync, renameSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { startTmuxSession } from "../src/tmux.js";
import { nativeOverrides } from "./native-app-server.js";

const exec = promisify(execFile), codex = process.env.FENJUE_CODEX_BIN ?? "codex";
if (process.argv[2] === "--pane") {
  const descriptor = JSON.parse(await readFile(process.argv[3]!, "utf8"));
  const child = spawn(codex, ["--remote", descriptor.endpoint, "-C", descriptor.temp, "-s", "read-only", "-a", "never",
    ...nativeOverrides({ "tui.alternate_screen": "never", "tui.animations": false }),
    "FENJUE_NATIVE_ROUTE sol medium"], { stdio: "inherit", env: { ...process.env, CODEX_HOME: descriptor.home } });
  const terminate = () => child.kill("SIGTERM"); process.on("SIGTERM", terminate);
  try { process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  }); } finally { process.off("SIGTERM", terminate); }
} else {
  const stateFile = process.argv[2]!, upstream = process.argv[3]!;
  assert.ok(stateFile && upstream, "Expected state path and local mock upstream");
  assert.ok(upstream.startsWith("http://127.0.0.1:"), "This fixture only accepts a local mock");
  const temp = await mkdtemp(join(tmpdir(), "fenjue-native-terminal-"));
  const home = join(temp, "home"), socket = join(temp, "app.sock"), descriptor = join(temp, "session.json");
  let session: Awaited<ReturnType<typeof startTmuxSession>> | undefined;
  const children = new Set<ReturnType<typeof spawn>>(), exits: Promise<void>[] = [];
  const state: any = { trace: [], completed: [], routes: [], temp };
  const save = () => { writeFileSync(stateFile + ".tmp", JSON.stringify(state)); renameSync(stateFile + ".tmp", stateFile); };
  const server = createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
  try {
    await mkdir(home);
    await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(temp)}]\ntrust_level = "trusted"\n`);
    const bundled = JSON.parse((await exec(codex, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024 })).stdout);
    const catalog = join(temp, "models.json");
    await writeFile(catalog, JSON.stringify({ models: bundled.models.filter((m: any) => ["gpt-6.1-sol", "gpt-6-astra"].includes(m.slug)) }));
    const settings = {
      model: "gpt-6.1-sol", model_provider: "native_fixture", model_catalog_json: catalog, sqlite_home: home, log_dir: home,
      "model_providers.native_fixture.name": "Native fixture", "model_providers.native_fixture.base_url": upstream,
      "model_providers.native_fixture.wire_api": "responses", "model_providers.native_fixture.env_key": "FENJUE_NATIVE_FIXTURE_KEY",
      "model_providers.native_fixture.requires_openai_auth": false, "model_providers.native_fixture.supports_websockets": false,
      "model_providers.native_fixture.request_max_retries": 0, "model_providers.native_fixture.stream_max_retries": 0,
      "features.apps": false, "features.plugins": false, "features.remote_plugin": false,
      "features.hooks": false, "features.memories": false, "features.shell_snapshot": false,
      "features.multi_agent": false, "features.skip_host_skill_discovery": true,
      "features.enable_request_compression": false, "features.reasoning_effort_override": false,
      "features.unbounded_connection_retries": false,
    };
    const trace = (direction: string, message: any) => {
      const params = message.params ?? {};
      state.trace.push({ direction, id: message.id, method: message.method,
        threadId: params.threadId, ephemeral: params.ephemeral, threadSource: params.threadSource,
        sessionStartSource: params.sessionStartSource, structuredOutput: Boolean(params.outputSchema),
        model: params.model, effort: params.effort, collaborationMode: params.collaborationMode ? {
          mode: params.collaborationMode.mode, model: params.collaborationMode.settings.model,
          effort: params.collaborationMode.settings.reasoning_effort,
          hasDeveloperInstructions: params.collaborationMode.settings.developer_instructions != null,
        } : params.collaborationMode,
        resultModel: message.result?.model, error: message.error });
      if (message.method === "turn/completed") state.completed.push({ threadId: params.threadId, id: params.turn.id, status: params.turn.status });
      save();
    };
    wss.on("connection", ws => {
      const child = spawn(codex, ["app-server", ...nativeOverrides(settings)], { stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", CODEX_HOME: home, FENJUE_NATIVE_FIXTURE_KEY: "local-fixture-only" } });
      children.add(child);
      exits.push(new Promise(resolve => child.once("close", () => { children.delete(child); resolve(); })));
      child.on("error", error => { state.failure = error.message; save(); ws.close(); });
      child.stderr.on("data", chunk => { state.stderr = ((state.stderr ?? "") + chunk).slice(-4000); save(); });
      child.stdin.on("error", error => { state.failure = error.message; save(); });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => { const message = JSON.parse(line); trace("server", message); if (ws.readyState === ws.OPEN) ws.send(line); });
      ws.on("message", data => {
        const message = JSON.parse(data.toString()); trace("client", message);
        if (message.method === "turn/start") {
          const text = (message.params.input ?? []).filter((i: any) => i.type === "text").map((i: any) => i.text).join("\n");
          const route = /^FENJUE_NATIVE_ROUTE (sol|astra) (low|medium|high)$/.exec(text);
          if (route) {
            const model = route[1] === "sol" ? "gpt-6.1-sol" : "gpt-6-astra", effort = route[2];
            message.params.model = model; message.params.effort = effort;
            if (message.params.collaborationMode) Object.assign(message.params.collaborationMode.settings, { model, reasoning_effort: effort });
            state.routes.push({ model, effort }); save();
            state.mainThreadId ??= message.params.threadId;
          }
        }
        child.stdin.write(JSON.stringify(message) + "\n");
      });
      ws.on("error", error => { state.failure = error.message; save(); });
      ws.once("close", () => { lines.close(); child.kill("SIGTERM"); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    await chmod(socket, 0o600);
    await writeFile(descriptor, JSON.stringify({ endpoint: `unix://${socket}`, temp, home }));
    session = await startTmuxSession([fileURLToPath(import.meta.url), "--pane", descriptor]);
    state.socket = session.socket; save();
    process.exitCode = await session.attach();
  } finally {
    await session?.close();
    for (const ws of wss.clients) ws.terminate();
    for (const child of children) child.kill("SIGTERM");
    const timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 3000);
    try { await Promise.all(exits); } finally { clearTimeout(timer); }
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}
