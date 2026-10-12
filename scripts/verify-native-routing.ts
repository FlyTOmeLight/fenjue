import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { NativeAppServer, nativeOverrides } from "./native-app-server.js";
import { readJSON, serve } from "../test/fixtures.js";

const exec = promisify(execFile), codex = process.env.FENJUE_CODEX_BIN ?? "codex";
const live = process.argv.includes("--live");
const sol = "gpt-6.1-sol", astra = "gpt-6-astra";
const temp = await mkdtemp(join(tmpdir(), "fenjue-native-"));
const reportDir = resolve(".fenjue/verification", `native-routing-${Date.now()}`);
const checks: string[] = [], turns: any[] = [], seen: any[] = [];
let client: NativeAppServer | undefined, upstream: Awaited<ReturnType<typeof serve>> | undefined;
let phase = "answer", toolSent = false;
let holdStarted: (() => void) | undefined, holdClosed: (() => void) | undefined;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
// Native switching preserves history and appends a developer <model_switch>
// message containing the new model's complete base instructions.
function instructions(body: any): string {
  const texts: string[] = (body.input ?? []).filter((item: any) => item.type === "message" && item.role === "developer")
    .flatMap((item: any) => item.content ?? []).map((part: any) => part.text).filter((text: unknown): text is string => typeof text === "string");
  return texts.findLast(text => text.startsWith("<model_switch>")) ?? body.instructions ?? texts[0] ?? "";
}

function allTools(body: any): any[] {
  return [...(body.tools ?? []), ...(body.input ?? []).filter((i: any) => i.type === "additional_tools").flatMap((i: any) => i.tools ?? [])]
    .flatMap((t: any) => t.type === "namespace" ? (t.tools ?? []).map((inner: any) => ({ ...inner, namespace: t.name })) : [t]);
}
try {
  const version = (await exec(codex, ["--version"])).stdout.trim();
  const bundled = JSON.parse((await exec(codex, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024 })).stdout);
  const selected = [sol, astra].map(slug => {
    const model = bundled.models.find((m: any) => m.slug === slug); assert.ok(model, `Missing model: ${slug}`); return model;
  });
  assert.notDeepEqual(selected[0].model_messages, selected[1].model_messages);
  const catalog = join(temp, "models.json");
  await writeFile(catalog, JSON.stringify({ models: selected }), { mode: 0o600 });
  const home = join(temp, "codex-home"); await mkdir(home);
  const settings: Record<string, unknown> = {
    model: sol, model_catalog_json: catalog, sqlite_home: home, log_dir: home,
    "features.apps": false, "features.plugins": false, "features.remote_plugin": false,
    "features.hooks": false, "features.memories": false, "features.shell_snapshot": false,
    "features.multi_agent": false, "features.skip_host_skill_discovery": true,
    "features.enable_request_compression": false, "features.reasoning_effort_override": false,
    "features.unbounded_connection_retries": false,
  };
  if (!live) {
    upstream = await serve(async (req, res) => {
      if (req.method !== "POST" || !req.url?.startsWith("/responses")) { res.writeHead(404); res.end(); return; }
      const body = await readJSON(req); seen.push(body);
      if (phase === "hold") { res.once("close", () => holdClosed?.()); holdStarted?.(); return; }
      const outputs = (body.input ?? []).filter((i: any) => ["function_call_output", "custom_tool_call_output"].includes(i.type));
      let item: any;
      if (["tool", "approval"].includes(phase) && !toolSent) {
        const tool = allTools(body).find(t => t.name === "exec_command") ?? allTools(body).find(t => t.name === "exec");
        assert.ok(tool, "Expected a native execution tool");
        const args = { cmd: phase === "approval" ? "printf NATIVE_APPROVAL_OK" : "printf NATIVE_TOOL_OK", max_output_tokens: 1000,
          ...(phase === "approval" ? { sandbox_permissions: "require_escalated", justification: "Controlled native approval fixture" } : {}) };
        item = tool.type === "custom" ?
          { type: "custom_tool_call", id: "fc_native", call_id: "call_native", name: tool.name, namespace: tool.namespace, input: `text(await tools.exec_command(${JSON.stringify(args)}))` } :
          { type: "function_call", id: "fc_native", call_id: "call_native", name: tool.name, namespace: tool.namespace,
            arguments: JSON.stringify(args) };
        toolSent = true;
      } else {
        if (phase === "tool") assert.ok(JSON.stringify(outputs).includes("NATIVE_TOOL_OK"), "Missing native tool output");
        if (phase === "approval") assert.match(JSON.stringify(outputs), /reject|denied|declin/i, "Approval denial did not reach the model");
        item = { type: "message", id: `msg_${seen.length}`, role: "assistant", phase: "final_answer",
          content: [{ type: "output_text", text: phase === "compact" ? "NATIVE_COMPACTED_CONTEXT: Native switch 1 and subsequent model-switch probes completed." : `NATIVE_OK_${seen.length} 中文🙂`, annotations: [] }] };
      }
      const response = { id: `resp_native_${seen.length}`, object: "response", status: "completed", model: body.model, output: [item],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, ...(item.type === "message" ? { content: [] } : {}) } },
        ...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text }] : []),
        { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response },
      ];
      res.writeHead(200, { "content-type": "text/event-stream", "openai-model": body.model });
      res.end(events.map((e, sequence_number) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number })}\n\n`).join(""));
    });
    Object.assign(settings, {
      model_provider: "native_fixture", "model_providers.native_fixture.name": "Native fixture",
      "model_providers.native_fixture.base_url": upstream.url, "model_providers.native_fixture.wire_api": "responses",
      "model_providers.native_fixture.env_key": "FENJUE_NATIVE_FIXTURE_KEY",
      "model_providers.native_fixture.requires_openai_auth": false, "model_providers.native_fixture.supports_websockets": false,
      "model_providers.native_fixture.request_max_retries": 0, "model_providers.native_fixture.stream_max_retries": 0,
    });
  }
  const env = live ? { ...process.env } : { PATH: process.env.PATH, LANG: "en_US.UTF-8", CODEX_HOME: home, FENJUE_NATIVE_FIXTURE_KEY: "local-fixture-only" };
  const startClient = async () => {
    const next = new NativeAppServer(codex, ["app-server", ...nativeOverrides(settings)], env);
    client = next; await next.initialize(); return next;
  };
  await startClient();
  const models = await client!.request("model/list", { includeHidden: false });
  for (const slug of [sol, astra]) assert.ok(models.data.some((m: any) => m.model === slug), `model/list missing ${slug}`);
  checks.push("native model catalog exposes Sol and Astra");
  const startThread = async (model: string) => client!.request("thread/start", {
    model, cwd: temp, sandbox: "read-only", approvalPolicy: "never", ephemeral: live,
  });
  async function run(threadId: string, model: string, effort: string, text: string, extra: Record<string, unknown> = {}) {
    const cursor = client!.messages.length, before = seen.length, startedAt = Date.now();
    const accepted = await client!.request("turn/start", { threadId, model, effort, input: [{ type: "text", text }], ...extra });
    const id = accepted.turn.id;
    const ended = await client!.waitFor(m => m.method === "turn/completed" && m.params?.threadId === threadId && m.params?.turn.id === id, cursor, live ? 180_000 : 30_000);
    assert.equal(ended.params.turn.status, "completed", JSON.stringify(ended.params.turn.error));
    const items = client!.messages.slice(cursor).filter(m => m.method === "item/completed" && m.params?.turnId === id).map(m => m.params.item);
    const answers = items.filter((item: any) => item.type === "agentMessage").map((item: any) => item.text).join("\n");
    assert.ok(answers, "Completed turn has no final answer event");
    const record = { threadId, turnId: id, submitted: { model, effort }, status: ended.params.turn.status, answer: answers, elapsedMs: Date.now() - startedAt };
    turns.push(record);
    console.log(JSON.stringify({ turn: turns.length, ...record.submitted, status: record.status, elapsedMs: record.elapsedMs }));
    return seen.slice(before);
  }
  const baselines = new Map<string, any>();
  if (!live) {
    for (const model of [sol, astra]) {
      const baseline = await startThread(model);
      const [request] = await run(baseline.thread.id, model, "medium", "Baseline contract probe");
      assert.equal(instructions(request), selected.find(m => m.slug === model).base_instructions, "Baseline did not use bundled model instructions");
      baselines.set(model, request);
    }
    assert.notEqual(digest(instructions(baselines.get(sol))), digest(instructions(baselines.get(astra))), "Fresh native models must have different instructions");
  }
  const thread = await startThread(sol), threadId = thread.thread.id;
  const routes = [{ model: sol, effort: "medium" }, { model: astra, effort: "high" }, { model: sol, effort: "low" }];
  for (const [index, route] of routes.entries()) {
    phase = index === 1 && !live ? "tool" : "answer";
    const prompt = live ? [
      "这是焚诀原生切换验证。记住随机标记 FJ_NATIVE_6294。不要调用工具，仅回复这个标记。",
      "从上一轮会话中取出随机标记，不要调用工具，仅回复该标记。",
      "最后一次验证：从本会话记忆中取出最初的随机标记，不要调用工具，仅回复标记。",
    ][index]! : `Native switch ${index + 1}`;
    const requests = await run(threadId, route.model, route.effort, prompt);
    if (live) assert.ok(turns.at(-1).answer.includes("FJ_NATIVE_6294"), "Cross-model history marker lost");
    else {
      assert.ok(requests.length >= (index === 1 ? 2 : 1));
      for (const request of requests) {
        assert.equal(request.model, route.model); assert.equal(request.reasoning.effort, route.effort);
        assert.ok(instructions(request).includes(instructions(baselines.get(route.model))), `Wrong native instructions after switching to ${route.model}`);
        if (index > 0) assert.ok(instructions(request).startsWith("<model_switch>"), "Expected native model-switch instructions");
      }
      if (index > 0) assert.ok(JSON.stringify(requests[0].input).includes("Native switch 1"), "History lost during model switch");
    }
  }
  checks.push(live ? "real Sol/Astra/Sol turns complete with cross-model history" : "Sol/Astra/Sol use each model's fresh native instructions and chosen effort");
  if (!live) {
    checks.push("native tool execution and continuation retain Astra/high", "final answer captured without a subsequent user message");
    phase = "approval"; toolSent = false;
    let approvals = 0;
    client!.onRequest = async message => {
      assert.equal(message.method, "item/commandExecution/requestApproval");
      assert.ok(message.params.command.includes("NATIVE_APPROVAL_OK")); approvals++;
      return { decision: "decline" };
    };
    await run(threadId, sol, "medium", "Deny the controlled fixture command", { approvalPolicy: "on-request", approvalsReviewer: "user" });
    assert.equal(approvals, 1); checks.push("native approval request and denial remain intact");
    phase = "hold";
    const started = new Promise<void>(resolve => { holdStarted = resolve; });
    const closed = new Promise<void>(resolve => { holdClosed = resolve; });
    const cursor = client!.messages.length;
    const holding = await client!.request("turn/start", { threadId, model: sol, effort: "medium", input: [{ type: "text", text: "Interrupt this held fixture request" }] });
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Cancel probe timed out")), 10_000); });
    try {
      await Promise.race([started, deadline]);
      await client!.request("turn/interrupt", { threadId, turnId: holding.turn.id });
      const interrupted = await client!.waitFor(m => m.method === "turn/completed" && m.params?.turn.id === holding.turn.id, cursor);
      assert.equal(interrupted.params.turn.status, "interrupted");
      await Promise.race([closed, deadline]);
    } finally { clearTimeout(timer!); }
    checks.push("native interrupt cancels upstream and preserves the thread");
    phase = "answer";
    const requests = await run(threadId, sol, "low", "Plan precedence probe", { collaborationMode: {
      mode: "plan", settings: { model: astra, reasoning_effort: "high", developer_instructions: null },
    } });
    assert.ok(requests.every(r => r.model === astra && r.reasoning.effort === "high"));
    const modes = requests[0].input.filter((i: any) => i.role === "developer").flatMap((i: any) => i.content ?? [])
      .map((part: any) => part.text).filter((text: unknown): text is string => typeof text === "string" && text.startsWith("<collaboration_mode>"));
    assert.ok(modes.at(-1)?.startsWith("<collaboration_mode># Plan Mode"), "The effective collaboration instructions must remain Plan mode");
    checks.push("Plan settings take precedence over top-level model and effort");
    await client!.close(); await startClient();
    const resumed = await client!.request("thread/resume", { threadId, cwd: temp, model: sol });
    assert.equal(resumed.thread.id, threadId);
    const requestsAfterResume = await run(threadId, sol, "low", "Resume native history", { collaborationMode: {
      mode: "default", settings: { model: sol, reasoning_effort: "low", developer_instructions: null },
    } });
    assert.ok(requestsAfterResume.every(r => r.model === sol && r.reasoning.effort === "low"));
    assert.ok(JSON.stringify(requestsAfterResume[0].input).includes("Native switch 1"));
    checks.push("persisted thread survives process restart and switches back to Sol");
    phase = "compact";
    const beforeCompact = client!.messages.length;
    await client!.request("thread/compact/start", { threadId });
    const compacted = await client!.waitFor(m => m.method === "item/completed" && m.params?.threadId === threadId && m.params?.item.type === "contextCompaction", beforeCompact);
    const compactDone = await client!.waitFor(m => m.method === "turn/completed" && m.params?.turn.id === compacted.params.turnId, beforeCompact);
    assert.equal(compactDone.params.turn.status, "completed");
    phase = "answer";
    const afterCompact = await run(threadId, astra, "high", "Continue after compaction", { collaborationMode: {
      mode: "default", settings: { model: astra, reasoning_effort: "high", developer_instructions: null },
    } });
    assert.ok(afterCompact.every(r => r.model === astra && r.reasoning.effort === "high" && instructions(r).includes(instructions(baselines.get(astra)))));
    assert.ok(JSON.stringify(afterCompact[0].input).includes("NATIVE_COMPACTED_CONTEXT"));
    checks.push("native compaction retains summary and supports subsequent Astra switch");
    assert.equal(upstream!.errors.length, 0);
  }
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  await writeFile(join(reportDir, "report.json"), JSON.stringify({ codex: version, live, checks, turns,
    requests: seen.map(r => ({ model: r.model, effort: r.reasoning?.effort, instructionsHash: digest(instructions(r)) })),
    realModelTurns: live ? turns.length : 0, passed: true }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, checks, realModelTurns: live ? turns.length : 0, report: join(reportDir, "report.json") }, null, 2));
} catch (error) {
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  if (!live) await writeFile(join(reportDir, "mock-requests.json"), JSON.stringify(seen, null, 2), { mode: 0o600 });
  await writeFile(join(reportDir, "report.json"), JSON.stringify({ live, passed: false, checks, turns, error: String(error),
    requests: seen.map(r => ({ model: r.model, effort: r.reasoning?.effort, instructionsHash: digest(instructions(r)) })) }, null, 2), { mode: 0o600 });
  if (client) console.error(client.stderr);
  for (const error of upstream?.errors ?? []) console.error("Fixture:", error.message);
  console.error("Failure report:", join(reportDir, "report.json"));
  throw error;
} finally {
  await client?.close(); await upstream?.close(); await rm(temp, { recursive: true, force: true });
}
