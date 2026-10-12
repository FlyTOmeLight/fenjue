import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parseConfig } from "../src/config.js";
import { NativeSession, type NativeMessage } from "../src/native-session.js";
import { NativeRecords, type NativeEvent } from "../src/native-records.js";
import { observedTasks, iterationReport } from "../src/feedback.js";
import { RepeatedErrors } from "../src/architect-review.js";
import { semanticConfig, classification } from "./fixtures.js";

const failure = (id: string, command = "node test.mjs", exitCode = 1) => ({ id, type: "commandExecution", command, exitCode, aggregatedOutput: exitCode ? "AssertionError: wrong order" : "ok" });
const edit = (id: string) => ({ id, type: "fileChange", status: "completed" });
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail("condition timed out"); await delay(5); }
}
async function fixture(t: any, mode: "complete" | "hold" | "budget" | "failure" | "missing-usage" | "timeout" | "tool-budget" = "complete", enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "fenjue-auto-review-"));
  const c = semanticConfig(); c.routes.deep = { model: "fixture-fast", effort: "high" };
  const config = parseConfig({ ...c, native: { ...(enabled ? { review: { model: "fixture-deep", maxReviewsPerTask: 1, maxTokens: 100,
    timeoutMs: mode === "timeout" ? 1000 : 120000, maxToolCalls: mode === "tool-budget" ? 1 : 20 } } : {}) } });
  const records = new NativeRecords(root, join(root, "daily"), ["private-test-key"], m => assert.fail(m));
  const server: NativeMessage[] = [], client: NativeMessage[] = [], events: NativeEvent[] = [];
  let session: NativeSession, next = 0, mainId = 0;
  const deliver = (m: NativeMessage) => session.fromServer(m);
  const send = (m: NativeMessage) => {
    server.push(structuredClone(m));
    if (typeof m.id !== "string") return;
    queueMicrotask(() => {
      if (m.method === "config/read") deliver({ id: m.id, result: { config: { mcp_servers: { external: { command: "fixture-mcp", enabled: true, tool_timeout_sec: null } } } } });
      else if (m.method === "thread/start") deliver({ id: m.id, result: { thread: { id: "expert" } } });
      else if (m.method === "turn/start" && m.params.threadId === "expert") {
        const turn = "review-turn";
        deliver({ id: m.id, result: { turn: { id: turn } } });
        deliver({ method: "turn/started", params: { threadId: "expert", turn: { id: turn } } });
        if (mode === "hold" || mode === "timeout") return;
        if (mode === "tool-budget") {
          deliver({ method: "item/started", params: { threadId: "expert", turnId: turn, item: { type: "commandExecution" } } }); return;
        }
        deliver({ id: "expert-approval", method: "item/commandExecution/requestApproval", params: { threadId: "expert" } });
        if (mode !== "missing-usage") deliver({ method: "thread/tokenUsage/updated", params: { threadId: "expert", turnId: turn, tokenUsage: { total: { totalTokens: mode === "budget" ? 101 : 20 } } } });
        if (mode === "budget") return;
        const item = { id: "review-answer", type: "agentMessage", phase: "final_answer", text: "修正结果顺序，password=private-test-key" };
        deliver({ method: "item/completed", params: { threadId: "expert", turnId: turn, item } });
        deliver({ method: "turn/completed", params: { threadId: "expert", turn: { id: turn, status: mode === "failure" ? "failed" : "completed", items: [item] } } });
      } else if (m.method === "turn/start" && m.params.threadId === "main") {
        const turn = "revision-" + (++mainId);
        deliver({ id: m.id, result: { turn: { id: turn } } });
        deliver({ method: "turn/started", params: { threadId: "main", turn: { id: turn } } });
        deliver({ method: "item/completed", params: { threadId: "main", turnId: turn, item: { id: "derived-user", type: "userMessage", content: m.params.input } } });
        deliver({ method: "thread/tokenUsage/updated", params: { threadId: "main", turnId: turn, tokenUsage: { last: { totalTokens: 30 }, total: { totalTokens: 50 } } } });
        deliver({ method: "turn/completed", params: { threadId: "main", turn: { id: turn, status: "completed", items: [failure("passed", "node test.mjs", 0)] } } });
      } else if (String(m.id).startsWith("fenjue")) deliver({ id: m.id, result: {} });
    });
  };
  let classifications = 0;
  session = new NativeSession(config, records, send, m => client.push(structuredClone(m)), e => events.push(e),
    async () => classification({ relation: ++classifications === 1 ? "new" : "continue" }));
  t.after(async () => { session.close(); await delay(5); await rm(root, { recursive: true, force: true }); });
  const request = async (method: string, params: any) => { const m = { id: ++next, method, params }; await session.fromClient(m); return m; };
  const start = await request("thread/start", { threadSource: "user", cwd: root });
  deliver({ id: start.id, result: { thread: { id: "main" }, model: "fixture-fast", reasoningEffort: "medium", cwd: root } });
  async function work(items = [failure("a"), edit("b"), failure("c")], extra: any = {}) {
    const m = await request("turn/start", { threadId: "main", input: [{ type: "text", text: "修复排序" }], approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: true }, ...extra });
    const turnId = "turn-" + m.id;
    deliver({ id: m.id, result: { turn: { id: turnId } } });
    deliver({ method: "turn/started", params: { threadId: "main", turn: { id: turnId } } });
    deliver({ method: "thread/tokenUsage/updated", params: { threadId: "main", turnId, tokenUsage: { last: { totalTokens: 20 }, total: { totalTokens: 20 } } } });
    for (const item of items) deliver({ method: "item/completed", params: { threadId: "main", turnId, item } });
    deliver({ method: "turn/completed", params: { threadId: "main", turn: { id: turnId, status: "completed", items } } });
    return turnId;
  }
  return { root, config, records, server, client, events, session, request, deliver, work };
}

test("daily review privately checks repeated failures and starts a visible revision with original permissions", async t => {
  const f = await fixture(t);
  await f.work(); const taskId = f.records.load("main")!.taskId;
  await until(() => f.events.some(e => e.type === "completed" && String(e.turnId).startsWith("revision")));
  const expert = f.server.find(m => m.method === "thread/start" && m.params.ephemeral)!;
  assert.equal(expert.params.sandbox, "read-only"); assert.equal(expert.params.approvalPolicy, "never");
  assert.deepEqual(expert.params.config.mcp_servers, { external: { command: "fixture-mcp", enabled: false } });
  const review = f.server.find(m => m.method === "turn/start" && m.params.threadId === "expert")!;
  assert.deepEqual(review.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(review.params.model, "fixture-deep"); assert.equal(review.params.effort, "high");
  const revision = f.server.find(m => typeof m.id === "string" && m.method === "turn/start" && m.params.threadId === "main")!;
  assert.match(revision.params.input[0].text, /核对当前代码/);
  assert.deepEqual(revision.params.sandboxPolicy, { type: "workspaceWrite", networkAccess: true });
  assert.equal(revision.params.approvalPolicy, "on-request"); assert.equal(revision.params.model, "fixture-fast");
  assert.equal(f.client.some(m => m.params?.threadId === "expert" || m.id === "expert-approval"), false);
  assert.deepEqual(f.server.find(m => m.id === "expert-approval")!.result, { decision: "decline" });
  assert.ok(f.client.some(m => m.method === "turn/started" && m.params.turn.id === "revision-1"));
  const state = f.records.load("main")!;
  assert.equal(state.taskId, taskId); assert.deepEqual(state.task.messages, ["修复排序"]);
  assert.deepEqual(state.review, { count: 1, revisionTurns: ["revision-1"] });
  const capture = await readFile(f.records.capturePath!, "utf8");
  assert.equal(capture.split('"kind":"user"').length - 1, 1);
  assert.doesNotMatch(await readFile(f.records.logPath, "utf8"), /private-test-key/);
  const report = iterationReport(await observedTasks(f.root));
  assert.equal(report.summary.reviews, 1); assert.equal(report.summary.automaticRevisions, 1);
  assert.equal(report.summary.observedTokens, 70); assert.equal(report.summary.reviewObservedTokens, 20);
  assert.deepEqual(report.summary.outcomes, { unknown: 1 });
  await f.work([failure("other1", "node other.mjs"), edit("other2"), failure("other3", "node other.mjs")]);
  await delay(20);
  assert.equal(f.server.filter(m => m.method === "thread/start" && m.params.ephemeral).length, 1);
});

test("new user input cancels a running expert and prevents stale revision", async t => {
  const f = await fixture(t, "hold"); await f.work();
  await until(() => f.server.some(m => m.method === "turn/start" && m.params.threadId === "expert"));
  await f.request("turn/start", { threadId: "main", input: [{ type: "text", text: "新的约束" }] });
  await until(() => f.events.some(e => e.type === "review-finished" && e.status === "cancelled"));
  assert.ok(f.server.some(m => m.method === "turn/interrupt" && m.params.threadId === "expert"));
  assert.equal(f.server.some(m => typeof m.id === "string" && m.method === "turn/start" && m.params.threadId === "main"), false);
});

test("manual mode cancels review without changing the main model", async t => {
  const f = await fixture(t, "hold"); await f.work();
  await until(() => f.server.some(m => m.method === "turn/start" && m.params.threadId === "expert"));
  f.session.setMode("manual");
  await until(() => f.events.some(e => e.type === "review-finished" && e.status === "cancelled"));
  assert.equal(f.records.load("main")!.mode, "manual");
});

test("switching user sessions cancels review without affecting auxiliary threads", async t => {
  const f = await fixture(t, "hold"); await f.work();
  await until(() => f.server.some(m => m.method === "turn/start" && m.params.threadId === "expert"));
  await f.request("thread/start", { ephemeral: true }); await delay(10);
  assert.equal(f.events.some(e => e.type === "review-finished"), false);
  await f.request("thread/start", { threadSource: "user", cwd: f.root });
  await until(() => f.events.some(e => e.type === "review-finished" && e.status === "cancelled"));
  assert.equal(f.server.some(m => typeof m.id === "string" && m.method === "turn/start" && m.params.threadId === "main"), false);
});

test("review ceiling survives an aligned native resume", async t => {
  const f = await fixture(t); await f.work();
  await until(() => f.events.some(e => e.type === "completed" && e.turnId === "revision-1"));
  const state = f.records.load("main")!; f.session.close();
  const server: NativeMessage[] = [];
  const session = new NativeSession(f.config, f.records, m => server.push(m), () => {}, () => {},
    async () => classification({ relation: "continue" }));
  t.after(() => session.close());
  await session.fromClient({ id: 10, method: "thread/resume", params: { threadId: "main" } });
  session.fromServer({ id: 10, result: { thread: { id: "main", turns: [{ id: state.lastTurnId, status: "completed" }] }, cwd: f.root } });
  await session.fromClient({ id: 11, method: "turn/start", params: { threadId: "main", input: [{ type: "text", text: "继续完善" }] } });
  session.fromServer({ id: 11, result: { turn: { id: "post-resume" } } });
  session.fromServer({ method: "turn/completed", params: { threadId: "main", turn: { id: "post-resume", status: "completed",
    items: [failure("new-a", "node other.mjs"), edit("new-b"), failure("new-c", "node other.mjs")] } } });
  await delay(10);
  assert.equal(f.records.load("main")!.review!.count, 1);
  assert.equal(server.some(m => m.method === "thread/start" && m.params.ephemeral), false);
});

for (const mode of ["budget", "failure", "missing-usage", "timeout", "tool-budget"] as const) test(`expert ${mode} records its outcome accurately`, async t => {
  const f = await fixture(t, mode); await f.work();
  await until(() => f.events.some(e => e.type === "review-finished"));
  await delay(15);
  const report = iterationReport(await observedTasks(f.root));
  if (mode === "missing-usage") {
    assert.equal(report.summary.observedTokens, null); assert.equal(report.summary.automaticRevisions, 1);
  } else {
    assert.equal(report.summary.automaticRevisions, 0);
    assert.ok(f.events.some(e => e.type === "review-error"));
  }
});

test("disabled, manual, plan, incomplete and resolved failures do not call an expert", async t => {
  for (const condition of ["disabled", "manual", "plan", "incomplete", "resolved"]) {
    const f = await fixture(t, "complete", condition !== "disabled");
    if (condition === "manual") f.session.setMode("manual");
    const extra = condition === "plan" ? { collaborationMode: { mode: "plan", settings: {} } } :
      condition === "incomplete" ? { input: [{ type: "image", url: "local" }] } : {};
    await f.work(condition === "resolved" ? [failure("a"), edit("b"), failure("c"), failure("ok", "node test.mjs", 0)] : undefined, extra);
    await delay(10);
    assert.equal(f.server.some(m => m.method === "thread/start" && m.params.ephemeral), false, condition);
  }
});

test("successful test runs clear previous failure evidence", () => {
  const errors = new RepeatedErrors();
  assert.equal(errors.observe([failure("a"), failure("passed", "node test.mjs", 0), edit("b"), failure("c")]), undefined);
});

test("review configuration validates limits and keeps the public example opt-in", () => {
  const c = semanticConfig();
  for (const review of [{ model: "fixture-deep", maxReviewsPerTask: 4 }, { model: "fixture-deep", maxTokens: 0 }, { model: "fixture-deep", timeoutMs: 0 }, { model: "fixture-deep", effort: "max" }]) {
    assert.throws(() => parseConfig({ ...c, native: { review } }), /native.review/);
  }
});
