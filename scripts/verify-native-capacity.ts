import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readJSON, serve, classification } from "../test/fixtures.js";
import { parseConfig } from "../src/config.js";
import { NativeRecords } from "../src/native-records.js";
import { nativeArguments } from "../src/native-launcher.js";
import { startNativeGateway } from "../src/native-gateway.js";
import { EvaluationClient } from "./native-evaluation-client.js";

// Replay the captured App Server capacity error while using installed Codex
// for the real turn lifecycle and model switch. Mock API transport errors have
// different codes from the logged-in backend; no text matching enters production.
const root = await mkdtemp(join(tmpdir(), "fenjue-native-capacity-"));
const codex = process.env.FENJUE_CODEX_BIN ?? "codex";
let gateway: Awaited<ReturnType<typeof startNativeGateway>> | undefined;
let upstream: Awaited<ReturnType<typeof serve>> | undefined, client: EvaluationClient | undefined;
const seen: any[] = [], events: any[] = [];
let phase = "recover";
const terminal = process.argv.includes("--terminal");
try {
  const home = join(root, "home"); await mkdir(home);
  upstream = await serve(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/responses")) { res.writeHead(404).end(); return; }
    const body = await readJSON(req);
    const structured = body.text?.format?.type === "json_schema";
    if (!structured) seen.push({ model: body.model, effort: body.reasoning?.effort, input: body.input });
    if (!structured && phase !== "next" && (phase === "both-fail" || body.model === "gpt-6.1-sol")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const failure = { type: "response.failed", response: { id: "overload", status: "failed",
        error: { code: "fixture_capacity", message: "CAPACITY_FIXTURE_REPLAY" } } };
      res.end(`event: response.failed\ndata: ${JSON.stringify(failure)}\n\n`); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const text = structured ? JSON.stringify(Object.fromEntries(Object.keys(body.text.format.schema?.properties ?? {}).map(k => [k, "Capacity fixture"]))) :
      phase === "next" ? "AFTER_CAPACITY_RETRY" : "CAPACITY_RETRY_OK";
    const item = { type: "message", id: "answer-" + seen.length, role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text, annotations: [] }] };
    const response = { id: "response-" + seen.length, object: "response", status: "completed", model: body.model,
      output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    const messages = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text },
      { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response },
    ];
    res.end(messages.map((m, sequence_number) => `event: ${m.type}\ndata: ${JSON.stringify({ ...m, sequence_number })}\n\n`).join(""));
  });
  const base = JSON.parse(await readFile("examples/native-balanced.json", "utf8"));
  const config = parseConfig({ ...base, auth: "mock", upstream: upstream.url, semantic: { ...base.semantic, mode: "auto" } });
  const settings = { sqlite_home: home, log_dir: home, "features.apps": false, "features.plugins": false,
    "features.remote_plugin": false, "features.hooks": false, "features.memories": false, "features.multi_agent": false,
    "features.shell_snapshot": false, "features.skip_host_skill_discovery": true, "features.reasoning_effort_override": false,
    "features.unbounded_connection_retries": false,
    "model_providers.fenjue_native_fixture.request_max_retries": 0, "model_providers.fenjue_native_fixture.stream_max_retries": 0 };
  const args = nativeArguments(config, Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`])).server;
  const records = new NativeRecords(root, join(root, "capture"), [], message => assert.fail(message));
  const replay = join(root, "codex-replay.mjs");
  await writeFile(replay, `#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const child=spawn(${JSON.stringify(codex)},process.argv.slice(2),{stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);
createInterface({input:child.stdout}).on('line',line=>{
  const m=JSON.parse(line),p=m.params;
  const captured={message:'Selected model is at capacity. Please try a different model.',codexErrorInfo:'serverOverloaded',additionalDetails:null,misalignment:null};
  if(m.method==='error'&&p.error?.message.includes('CAPACITY_FIXTURE_REPLAY'))p.error=captured;
  if(m.method==='turn/completed'&&p.turn.error?.message.includes('CAPACITY_FIXTURE_REPLAY'))p.turn.error=captured;
  process.stdout.write(JSON.stringify(m)+'\\n');
});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??1));
`, { mode: 0o700 });
  gateway = await startNativeGateway({ socket: join(root, "app.sock"), executable: replay, serverArgs: args,
    env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", CODEX_HOME: home, FENJUE_NATIVE_FIXTURE_KEY: "local-fixture-only" },
    config, records, classify: async () => classification({ reasoning: "diagnosis" }), onEvent: e => events.push(e),
    onFailure: error => { throw error; } });
  let terminalResult: Promise<{ stdout: string; stderr: string }> | undefined, threadId: string;
  const input = [{ type: "text", text: "CAPACITY_ORIGINAL_INPUT: regenerate the expired code." }];
  if (terminal) {
    terminalResult = promisify(execFile)("python3", [resolve("scripts/native-review-terminal.py"), codex, join(root, "app.sock"), root, home,
      input[0]!.text, "CAPACITY_RETRY_OK", "AFTER_CAPACITY_RETRY"], { timeout: 60000 });
    terminalResult.catch(() => {});
  } else {
    client = new EvaluationClient(join(root, "app.sock"), () => {}); await client.open();
    const started = await client.request("thread/start", { threadSource: "user", cwd: root, sandbox: "read-only", approvalPolicy: "never", model: "gpt-6.1-sol" });
    threadId = started.thread.id;
    await client.request("turn/start", { threadId, input, collaborationMode: { mode: "plan",
      settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: "Fixture plan instructions" } } });
  }
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Capacity fixture timed out: " + JSON.stringify({ events,
        errors: client?.messages.filter(m => m.method === "error" || m.method === "turn/completed") }));
      await delay(20);
    }
  }
  await until(() => events.some(e => e.type === "completed"));
  assert.equal(events.find(e => e.type === "completed")?.error?.codexErrorInfo, "serverOverloaded");
  await until(() => events.some(e => e.type === "completed" && e.status === "completed"));
  assert.equal(events.filter(e => e.type === "retrying").length, 1);
  assert.deepEqual(seen.map(s => [s.model, s.effort]), [["gpt-6.1-sol", "high"], ["gpt-6-astra", "high"]]);
  assert.ok(JSON.stringify(seen[1].input).includes("CAPACITY_ORIGINAL_INPUT"));
  assert.equal(records.load(events.find(e => e.type === "bound").threadId)!.task.messages.length, 1);
  if (terminalResult) {
    phase = "next";
    console.log((await terminalResult).stdout.trim());
  } else {
    assert.ok(JSON.stringify(seen[1].input).includes("Fixture plan instructions"));
    assert.ok(client!.messages.some(m => m.params?.item?.text === "CAPACITY_RETRY_OK"));
    phase = "both-fail";
    const before = events.length;
    await client!.request("turn/start", { threadId: threadId!, input: [{ type: "text", text: "Another capacity fixture task." }] });
    await until(() => events.slice(before).some(e => e.type === "completed" && e.previousError));
    assert.equal(events.slice(before).filter(e => e.type === "retrying").length, 1);
    assert.equal(seen.length, 4, "second overload must not produce a third attempt");
    phase = "next";
    const next = await client!.request("turn/start", { threadId: threadId!, input: [{ type: "text", text: "Continue after retry." }] });
    await client!.completed(next.turn.id, 20000);
    assert.ok(client!.messages.some(m => m.params?.item?.text === "AFTER_CAPACITY_RETRY"));
  }
  assert.deepEqual(upstream.errors, []);
  console.log(JSON.stringify({ passed: true, version: (await promisify(execFile)(codex, ["--version"])).stdout.trim(),
    checks: ["captured native capacity error replay", "one model switch", "input preserved", "next user turn works",
      ...(terminal ? ["real TUI retry answer displayed"] : ["Plan preserved", "both failures stop"])],
    localModelRequests: seen.length }));
} finally {
  client?.close(); await gateway?.close(); await upstream?.close(); await rm(root, { recursive: true, force: true });
}
