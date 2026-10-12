import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSession, type NativeMessage } from "../src/native-session.js";
import { NativeRecords, type NativeEvent } from "../src/native-records.js";
import { ExecutionCapture, executionDraft } from "../src/execution-capture.js";
import { nativeSelection, validateNativeCatalog } from "../src/native-policy.js";
import { nativeArguments } from "../src/native-launcher.js";
import { parseConfig } from "../src/config.js";
import { draftCase } from "../src/cases.js";
import { fingerprint, type TaskView } from "../src/task-state.js";
import { type Classify, type Features, type QuestionScores, ClassificationError } from "../src/classification.js";
import { classification, semanticConfig, models } from "./fixtures.js";

function config() {
  const c = semanticConfig(); c.routes.deep = { model: "fixture-fast", effort: "high" }; c.native = { expertModel: "fixture-deep" }; return c;
}
async function fixture(t: any, classify: Classify, execution = false, c = config()) {
  const dir = await mkdtemp(join(tmpdir(), "fenjue-native-test-"));
  await mkdir(join(dir, "source")); await writeFile(join(dir, "source", "code.txt"), "before");
  const cases = join(dir, "execution-cases");
  const executionCapture = execution ? new ExecutionCapture({ directory: cases, projects: [{ directory: dir, paths: ["source"] }] },
    ["test-secret-12345"], message => assert.fail(message)) : undefined;
  const records = new NativeRecords(dir, join(dir, "capture"), ["test-secret-12345"], message => assert.fail(message), undefined, executionCapture);
  const server: NativeMessage[] = [], client: NativeMessage[] = [], events: NativeEvent[] = [];
  const session = new NativeSession(c, records, m => server.push(structuredClone(m)), m => client.push(structuredClone(m)), e => events.push(e), classify);
  const sessions = [session];
  t.after(async () => { for (const session of sessions) session.close(); await rm(dir, { recursive: true, force: true }); });
  let id = 0;
  const request = async (method: string, params: any) => { const m = { id: ++id, method, params }; await session.fromClient(m); return m; };
  async function bind() {
    const m = await request("thread/start", { threadSource: "user", ephemeral: false, cwd: dir });
    session.fromServer({ id: m.id, result: { thread: { id: "thread" }, model: "fixture-fast", reasoningEffort: "medium" } });
  }
  const start = (text: string, extra: any = {}) => request("turn/start", { threadId: "thread", input: [{ type: "text", text }],
    model: "fixture-fast", effort: "medium", ...extra });
  const accept = (request: NativeMessage, turnId = `turn-${request.id}`) => {
    session.fromServer({ id: request.id, result: { turn: { id: turnId, status: "inProgress" } } });
    session.fromServer({ method: "turn/started", params: { threadId: "thread", turn: { id: turnId } } });
    return turnId;
  };
  const complete = (turnId: string, status = "completed") => session.fromServer({ method: "turn/completed", params: { threadId: "thread", turn: { id: turnId, status, items: [] } } });
  await bind();
  return { dir, cases, records, server, client, events, session, sessions, request, start, accept, complete };
}

const overload = { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded" };
function capacityFailure(f: Awaited<ReturnType<typeof fixture>>, turnId: string, items: any[] = [], error = overload) {
  f.session.fromServer({ method: "turn/completed", params: { threadId: "thread", turn: { id: turnId, status: "failed", items, error } } });
}

test("capacity retry switches model once, keeps Plan/input/permissions and does not reclassify or recapture the user", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return classification({ reasoning: "diagnosis" }); }, true);
  const first = await f.start("重新生成授权码", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" },
    collaborationMode: { mode: "plan", settings: { model: "fixture-fast", reasoning_effort: "high", developer_instructions: "Keep plan" } } });
  const params = structuredClone(f.server.at(-1)!.params);
  const turn = f.accept(first);
  capacityFailure(f, turn, [{ type: "userMessage", id: "user-1", content: params.input }]);
  const retry = f.server.at(-1)!;
  assert.notEqual(retry.id, first.id); assert.equal(retry.method, "turn/start");
  assert.deepEqual(retry.params, { ...params, model: "fixture-deep",
    collaborationMode: { ...params.collaborationMode, settings: { ...params.collaborationMode.settings, model: "fixture-deep" } } });
  assert.equal(calls, 1); assert.equal(f.events.filter(e => e.type === "retrying").length, 1);
  const casePath = join(f.cases, (await readdir(f.cases)).find(name => name.startsWith("daily-"))!, "capture.json");
  assert.deepEqual(JSON.parse(await readFile(casePath, "utf8")).outcomes, {}, "retry is still in progress");
  const second = f.accept(retry, "retry-turn");
  assert.equal(f.client.some(m => m.id === retry.id), false, "internal retry response must stay private");
  f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: second,
    item: { type: "userMessage", id: "user-2", content: params.input } } });
  assert.deepEqual(f.records.load("thread")!.task.messages, ["重新生成授权码"]);
  const frames = (await readFile(f.records.capturePath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(frames.flatMap(frame => frame.items).filter(item => item?.kind === "user").length, 1);
  capacityFailure(f, second);
  assert.equal(f.server.filter(m => m.method === "turn/start").length, 2);
  assert.deepEqual(f.events.findLast(e => e.type === "completed")!.previousError, overload);
  const capture = JSON.parse(await readFile(casePath, "utf8"));
  assert.deepEqual(capture.turnIds, [second]); assert.deepEqual(capture.outcomes, { [second]: "failed" });
});

test("capacity retry works when the failed turn completes before its start response", async t => {
  const f = await fixture(t, async () => classification());
  const first = await f.start("执行任务");
  f.session.fromServer({ method: "turn/started", params: { threadId: "thread", turn: { id: "first" } } });
  capacityFailure(f, "first");
  const retry = f.server.at(-1)!;
  assert.notEqual(retry.id, first.id);
  f.session.fromServer({ id: first.id, result: { turn: { id: "first", status: "inProgress" } } });
  const second = f.accept(retry, "second"); f.complete(second);
  assert.equal(f.events.filter(e => e.type === "retrying").length, 1);
  assert.equal(f.events.at(-1)!.status, "completed");
});

test("capacity retry respects available model efforts in both directions", async t => {
  for (const [features, expected] of [
    [{ reasoning: "mechanical" }, { model: "fixture-deep", effort: "medium" }],
    [{ scope: "cross_system", reasoning: "diagnosis" }, { model: "fixture-fast", effort: "high" }],
  ] as const) {
    const f = await fixture(t, async () => classification(features));
    capacityFailure(f, f.accept(await f.start("执行任务")));
    const retry = f.server.at(-1)!;
    assert.equal(retry.params.model, expected.model); assert.equal(retry.params.effort, expected.effort);
    f.complete(f.accept(retry, "retry-ok"));
    assert.equal(f.events.at(-1)!.status, "completed");
  }
});

test("capacity retry never repeats a turn after output, tool start, approval or a steer", async t => {
  const cases = [
    { method: "item/agentMessage/delta", params: { delta: "已有输出" } },
    { method: "item/reasoning/summaryTextDelta", params: { delta: "思考摘要" } },
    { method: "item/started", params: { item: { type: "commandExecution", id: "tool" } } },
    { method: "item/started", params: { item: { type: "mcpToolCall", id: "mcp" } } },
    { id: "approval", method: "item/commandExecution/requestApproval", params: {} },
    { method: "item/tool/requestUserInput", params: {} },
  ];
  for (const notification of cases) {
    const f = await fixture(t, async () => classification());
    const turn = f.accept(await f.start("执行任务"));
    f.session.fromServer({ ...notification, params: { ...notification.params, threadId: "thread", turnId: turn } });
    capacityFailure(f, turn);
    assert.equal(f.server.filter(m => m.method === "turn/start").length, 1, notification.method);
  }
  const f = await fixture(t, async () => classification());
  const turn = f.accept(await f.start("执行任务"));
  await f.start("执行中补充了约束"); capacityFailure(f, turn);
  assert.equal(f.server.filter(m => m.method === "turn/start").length, 2, "steer must not be replayed");
});

test("completion-only output and non-capacity errors do not trigger retry", async t => {
  for (const [items, error] of [
    [[{ type: "agentMessage", id: "answer", text: "已输出" }], overload],
    [[{ type: "commandExecution", id: "tool", exitCode: 1 }], overload],
    [[], { message: "Quota exceeded", codexErrorInfo: "usageLimitExceeded" }],
    [[], { message: overload.message, codexErrorInfo: "other" }],
  ] as const) {
    const f = await fixture(t, async () => classification());
    capacityFailure(f, f.accept(await f.start("执行任务")), [...items], error);
    assert.equal(f.server.filter(m => m.method === "turn/start").length, 1);
  }
});

test("manual, shadow, interrupted, switched and single-model sessions do not retry", async t => {
  for (const option of ["manual", "shadow", "interrupt", "switch", "single-model"] as const) {
    const c = config(); if (option === "single-model") delete c.native!.expertModel;
    const f = await fixture(t, async () => classification(), false, c);
    if (option === "manual" || option === "shadow") f.session.setMode(option);
    const turn = f.accept(await f.start("执行任务"));
    if (option === "interrupt") await f.request("turn/interrupt", { threadId: "thread", turnId: turn });
    if (option === "switch") await f.request("thread/start", { threadSource: "user", cwd: f.dir });
    capacityFailure(f, turn);
    assert.equal(f.server.filter(m => m.method === "turn/start").length, 1, option);
  }
});

test("retry start rejection reports both failures without leaking internal responses", async t => {
  const f = await fixture(t, async () => classification());
  capacityFailure(f, f.accept(await f.start("执行任务")));
  const retry = f.server.at(-1)!;
  f.session.fromServer({ id: retry.id, error: { code: -1, message: "Backup denied" } });
  assert.equal(f.events.at(-1)!.type, "retry-failed");
  assert.deepEqual(f.events.at(-1)!.previousError, overload);
  assert.equal(f.client.some(m => m.id === retry.id), false);
  assert.equal(f.server.filter(m => m.method === "turn/start").length, 2);
});

test("native balanced policy separates local diagnosis, broad integration and broad unknown faults", () => {
  const c = config(); validateNativeCatalog(models(), c);
  for (const [features, model, effort] of [
    [{ reasoning: "mechanical" }, "fixture-fast", "low"],
    [{ reasoning: "mechanical", scope: "cross_system" }, "fixture-deep", "low"],
    [{ reasoning: "solution", scope: "multifile" }, "fixture-fast", "medium"],
    [{ reasoning: "diagnosis", uncertainty: "unknown_cause" }, "fixture-fast", "high"],
    [{ reasoning: "solution", scope: "cross_system" }, "fixture-deep", "medium"],
    [{ reasoning: "diagnosis", scope: "cross_system" }, "fixture-deep", "high"],
  ] as const) assert.deepEqual(nativeSelection(c, classification(features)).route, { model, effort });
  const uncertain = classification({ scope: "cross_system", reasoning: "diagnosis" });
  Object.assign(uncertain.questionScores.scope, { confidence: 0.1, probabilities: { cross_system: 0.4, local: 0.3, multifile: 0.3 } });
  assert.equal(nativeSelection(c, uncertain).route.model, "fixture-fast");
  assert.deepEqual(nativeSelection(c, classification({ relation: "uncertain" }), { model: "fixture-deep", effort: "high" }).route, { model: "fixture-deep", effort: "high" });
  assert.throws(() => validateNativeCatalog({ models: models().models.slice(0, 1) }, c), /不支持/);
});

test("zero native threshold cannot turn absent expert or high-effort evidence into an upgrade", () => {
  const c = config(); c.semantic!.minConfidence = 0;
  for (const [reasoning, effort] of [["mechanical", "low"], ["solution", "medium"], ["diagnosis", "high"]] as const) {
    assert.deepEqual(nativeSelection(c, classification({ reasoning })).route, { model: "fixture-fast", effort });
  }
});

test("constraint candidates separate capability from service count, reasoning depth and failures", () => {
  const c = config(); c.native!.expertPolicy = "constraints";
  for (const { features, coupled, model, effort } of [
    { features: { reasoning: "architecture" as const }, coupled: 1, model: "fixture-deep", effort: "high" },
    { features: { scope: "cross_system" as const, reasoning: "solution" as const }, coupled: 0, model: "fixture-fast", effort: "medium" },
    { features: { reasoning: "diagnosis" as const, uncertainty: "unknown_cause" as const }, coupled: 0, model: "fixture-fast", effort: "high" },
    { features: { reasoning: "solution" as const }, coupled: 1, model: "fixture-deep", effort: "medium" },
    { features: { reasoning: "mechanical" as const }, coupled: 0, model: "fixture-fast", effort: "low" },
    { features: { reasoning: "mechanical" as const }, coupled: 1, model: "fixture-deep", effort: "low" },
  ]) {
    const result = { ...classification(features), constraints: { choice: coupled ? "coupled" as const : "independent" as const,
      confidence: 1, probabilities: { coupled, independent: 1 - coupled } } };
    assert.deepEqual(nativeSelection(c, result).route, { model, effort });
  }
  assert.throws(() => nativeSelection(c, classification()), /missing-constraint-score/);
  const uncertain = { ...classification({ reasoning: "solution" }), constraints: { choice: "coupled" as const,
    confidence: 0.55, probabilities: { coupled: 0.55, independent: 0.45 } } };
  const retained = nativeSelection(c, uncertain, { model: "fixture-deep", effort: "high" });
  assert.deepEqual(retained.route, { model: "fixture-deep", effort: "medium" });
  assert.deepEqual(retained.held, ["model"]);
  c.semantic!.minConfidence = 0;
  uncertain.constraints.probabilities = { coupled: 0, independent: 1 };
  assert.equal(nativeSelection(c, uncertain).route.model, "fixture-fast");
});

test("native candidate followups retain history while reducing expert effort and then model", async t => {
  const c = config(); c.native!.expertPolicy = "constraints";
  const views: TaskView[] = [];
  let answer: ReturnType<typeof classification> = { ...classification({ reasoning: "architecture" }), constraints: { choice: "coupled" as const,
    confidence: 1, probabilities: { coupled: 1, independent: 0 } } };
  const f = await fixture(t, async view => { views.push(structuredClone(view)); return answer; }, false, c);
  f.complete(f.accept(await f.start("设计单系统内公平性、优先级和截止时间互相制约的调度策略")));
  assert.deepEqual(f.records.load("thread")!.route, { model: "fixture-deep", effort: "high" });
  answer = { ...answer, ...classification({ relation: "continue", reasoning: "solution" }) };
  f.complete(f.accept(await f.start("继续同时处理这几项约束，但本轮只实现已确定的一部分逻辑")));
  assert.deepEqual(f.records.load("thread")!.route, { model: "fixture-deep", effort: "medium" });
  const simple = { ...classification({ relation: "continue", reasoning: "mechanical" }), constraints: {
    choice: "independent" as const, confidence: 1, probabilities: { coupled: 0, independent: 1 } } };
  const next = new NativeSession(c, f.records, m => f.server.push(structuredClone(m)), m => f.client.push(m),
    e => f.events.push(e), async view => { views.push(structuredClone(view)); return simple; });
  f.sessions.push(next);
  await next.fromClient({ id: "resume-candidate", method: "thread/resume", params: { threadId: "thread" } });
  next.fromServer({ id: "resume-candidate", result: { thread: { id: "thread", turns: [{ id: "turn-3" }] },
    model: "fixture-deep", reasoningEffort: "medium" } });
  await next.fromClient({ id: "summary-candidate", method: "turn/start", params: { threadId: "thread",
    input: [{ type: "text", text: "把刚才的方案整理成三点，不增加分析" }] } });
  const sent = f.server.at(-1)!;
  assert.equal(sent.params.model, "fixture-fast"); assert.equal(sent.params.effort, "low");
  assert.match(f.events.findLast(e => e.type === "planned")!.policy as string, /^constraints-native-v3:/);
  assert.match(views.at(-1)!.currentTask.messages[0]!, /公平性/);
});

test("new-thread defaults cannot override resumed model/effort and explicit model options remain manual", () => {
  const c = config();
  assert.ok(nativeArguments(c, []).client.includes('model="fixture-fast"'));
  assert.ok(!nativeArguments(c, ["-C", "/tmp", "resume", "--last"]).client.includes('model_reasoning_effort="medium"'));
  assert.ok(nativeArguments(c, ["resume", "--last", "-m", "fixture-deep"]).manual);
  assert.throws(() => nativeArguments(c, ["--profile", "work"]), /尚未验证/);
});

test("native automatic selection preserves Plan and permissions; steers and tools retain the accepted turn", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return classification({ scope: "cross_system", reasoning: "diagnosis" }); });
  const first = await f.start("排查跨系统故障", { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" },
    collaborationMode: { mode: "plan", settings: { model: "fixture-fast", reasoning_effort: "low", developer_instructions: "Keep exact plan" } } });
  const sent = f.server.at(-1)!.params;
  assert.equal(sent.model, "fixture-deep"); assert.equal(sent.effort, "high");
  assert.deepEqual(sent.collaborationMode, { mode: "plan", settings: { model: "fixture-deep", reasoning_effort: "high", developer_instructions: "Keep exact plan" } });
  assert.equal(sent.approvalPolicy, "never"); assert.deepEqual(sent.sandboxPolicy, { type: "readOnly" });
  const turn = f.accept(first);
  await f.start("执行中补充指令", { model: "fixture-fast", effort: "low" });
  assert.equal(f.server.at(-1)!.params.model, "fixture-deep"); assert.equal(calls, 1);
  const approval = { id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread" } };
  f.session.fromServer(approval); assert.deepEqual(f.client.at(-1), approval);
  const answer = { id: "approval", result: { decision: "decline" } };
  await f.session.fromClient(answer); assert.deepEqual(f.server.at(-1), answer);
  f.complete(turn);
  await f.start("", { input: [], toolOutput: { arbitrary: "pass through" } }); assert.equal(calls, 1);
});

test("manual selection is acknowledged, ordinary model echo stays auto, and control resumes classification", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return classification(); });
  f.complete(f.accept(await f.start("改名字"))); assert.equal(calls, 1);
  const update = await f.request("thread/settings/update", { threadId: "thread", model: "fixture-deep", effort: "max" });
  f.session.fromServer({ id: update.id, result: {} });
  f.complete(f.accept(await f.start("手动任务", { model: "fixture-deep", effort: "max" })));
  assert.equal(f.server.at(-1)!.params.effort, "max"); assert.equal(calls, 1);
  assert.equal(f.records.load("thread")!.mode, "manual");
  f.session.setMode("auto");
  f.complete(f.accept(await f.start("[new] 新任务：大写 abc"))); assert.equal(calls, 2);
  assert.equal(f.server.at(-1)!.params.effort, "low"); assert.equal(f.records.load("thread")!.mode, "auto");
});

test("native pending classification cancels without executing; rejected turns cannot advance task state", async t => {
  let resolve!: (value: ReturnType<typeof classification>) => void;
  const f = await fixture(t, () => new Promise(r => { resolve = r; }));
  const pending = f.start("待分类任务");
  await f.request("turn/interrupt", { threadId: "thread", turnId: "not-started" });
  resolve(classification()); await pending;
  assert.equal(f.server.filter(m => m.method === "turn/start").length, 0);
  assert.equal(f.records.load("thread")!.task.messages.length, 0);
  const next = f.start("尚未接受"); resolve(classification()); const submitted = await next;
  f.session.fromServer({ id: submitted.id, error: { code: -1, message: "denied" } });
  assert.equal(f.records.load("thread")!.task.messages.length, 0);
});

test("final answer is captured without a next prompt; private reasoning excluded and gold labels stay empty", async t => {
  const f = await fixture(t, async () => classification());
  const turnId = f.accept(await f.start("输出结果 test-secret-12345"));
  const item = { type: "agentMessage", id: "answer", phase: "final_answer", text: "最终回答 test-secret-12345" };
  f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId, item } });
  f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId, item: { type: "reasoning", id: "reasoning", text: "PRIVATE_THOUGHT" } } });
  f.session.fromServer({ method: "turn/completed", params: { threadId: "thread", turn: { id: turnId, status: "completed", items: [item] } } });
  const draft = await draftCase(f.records.capturePath!, fingerprint("thread"));
  assert.deepEqual(draft.outcome, { quality: "unknown", trailingEvidence: ["最终回答 [REDACTED]"] });
  assert.equal(draft.case.turns[0]!.expected, null);
  assert.equal(draft.case.turns[0]!.evidence, undefined);
  const log = await readFile(f.records.logPath, "utf8");
  assert.ok(!log.includes("test-secret") && !log.includes("PRIVATE_THOUGHT"));
  assert.equal(f.events.filter(e => e.type === "final-answer").length, 1);
  const state = await readFile(join(f.dir, "native-state", (await readdir(join(f.dir, "native-state")))[0]!), "utf8");
  assert.ok(!state.includes("test-secret") && state.includes("[REDACTED]"));
});

test("saved task restores across processes, incomplete resume keeps its floor, and title threads bypass routing", async t => {
  const views: TaskView[] = [];
  const f = await fixture(t, async view => { views.push(structuredClone(view)); return classification({ scope: "cross_system", reasoning: "diagnosis" }); });
  const turnId = f.accept(await f.start("原始约束：保留审计记录")); f.complete(turnId);
  f.session.close();
  const server: NativeMessage[] = [];
  const session = new NativeSession(config(), f.records, m => server.push(m), () => {}, () => {}, async () => { throw new ClassificationError("timeout"); });
  f.sessions.push(session);
  await session.fromClient({ id: 100, method: "thread/resume", params: { threadId: "thread" } });
  assert.equal(server.at(-1)!.params.config.model_reasoning_effort, "high");
  session.fromServer({ id: 100, result: { thread: { id: "thread", turns: [{ id: turnId, status: "completed" }] }, model: "fixture-deep", reasoningEffort: "high" } });
  await session.fromClient({ id: 101, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: "继续" }] } });
  assert.equal(server.at(-1)!.params.model, "fixture-deep"); assert.equal(views.length, 1);
  assert.deepEqual(f.records.load("thread")!.task.messages, ["原始约束：保留审计记录"]);
  await session.fromClient({ id: 102, method: "thread/start", params: { threadSource: "thread_title", ephemeral: true } });
  session.fromServer({ id: 102, result: { thread: { id: "title" }, model: "fixture-fast" } });
  const aux = { id: 103, method: "turn/start", params: { threadId: "title", model: "fixture-fast", input: [{ type: "text", text: "generate title" }] } };
  await session.fromClient(aux); assert.deepEqual(server.at(-1), aux); assert.equal(f.records.load("title"), undefined);
});

test("resumed paginated history aligns to the newest native turn and preserves the original classifier context", async t => {
  const f = await fixture(t, async () => classification({ reasoning: "diagnosis" }));
  const turnId = f.accept(await f.start("目标和审计约束")); f.complete(turnId); f.session.close();
  let view: TaskView | undefined;
  const session = new NativeSession(config(), f.records, () => {}, () => {}, () => {}, async v => {
    view = v; return classification({ relation: "continue", reasoning: "solution" });
  }); f.sessions.push(session);
  await session.fromClient({ id: 1, method: "thread/resume", params: { threadId: "thread", excludeTurns: true, initialTurnsPage: { limit: 10 } } });
  session.fromServer({ id: 1, result: { thread: { id: "thread", turns: [] }, model: "fixture-fast", reasoningEffort: "high",
    initialTurnsPage: { data: [{ id: turnId, status: "completed" }, { id: "older" }] } } });
  await session.fromClient({ id: 2, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: "补充一个条件" }] } });
  assert.ok(view); assert.deepEqual(view.currentTask.messages, ["目标和审计约束"]); assert.equal(view.currentTask.incomplete, false);
});

test("execution snapshot precedes native send, deduplicates input and excludes reasoning", async t => {
  const f = await fixture(t, async () => classification({ relation: "continue" }), true);
  const first = await f.start("Fix this code");
  assert.equal(f.server.at(-1)!.method, "turn/start");
  const names = await readdir(f.cases); assert.equal(names.length, 1);
  const directory = join(f.cases, names[0]!);
  assert.equal(await readFile(join(directory, "snapshot/source/code.txt"), "utf8"), "before");
  assert.deepEqual((await executionDraft(directory)).task.prompts, []);
  await writeFile(join(f.dir, "source/code.txt"), "after");
  const turn = f.accept(first);
  f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: turn,
    item: { type: "userMessage", id: "initial", content: [{ type: "text", text: "Fix this code" }] } } });
  f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: turn,
    item: { type: "reasoning", id: "hidden", text: "PRIVATE_THOUGHT" } } });
  f.complete(turn);
  f.complete(f.accept(await f.start("继续")));
  assert.equal((await readdir(f.cases)).length, 1);
  assert.equal(await readFile(join(directory, "snapshot/source/code.txt"), "utf8"), "before");
  const draft = await executionDraft(directory); assert.deepEqual(draft.task.prompts, ["Fix this code", "继续"]);
  assert.ok(!(await readFile(join(directory, "items.jsonl"), "utf8")).includes("PRIVATE_THOUGHT"));
  f.complete(f.accept(await f.start("[new] Start another task")));
  assert.equal((await readdir(f.cases)).length, 2);
});

test("native snapshot preparation can be cancelled and rejected without leaving provisional cases", async t => {
  const f = await fixture(t, async () => classification(), true);
  const prepare = f.records.prepareExecution.bind(f.records);
  let ready!: () => void, release!: () => void;
  const prepared = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  f.records.prepareExecution = async (...args) => { await prepare(...args); ready(); await gate; };
  const pending = f.start("Cancel this task"); await prepared;
  await f.request("turn/interrupt", { threadId: "thread", turnId: "not-started" }); release(); await pending;
  assert.equal(f.server.filter(m => m.method === "turn/start").length, 0);
  assert.deepEqual(await readdir(f.cases), []);
  f.records.prepareExecution = prepare;
  const rejected = await f.start("Rejected task");
  f.session.fromServer({ id: rejected.id, error: { code: -1, message: "denied" } });
  assert.deepEqual(await readdir(f.cases), []);
});

test("unknown resumed history does not fabricate a fresh starting snapshot", async t => {
  const f = await fixture(t, async () => classification({ relation: "continue" }), true);
  const request = { id: 99, method: "thread/resume", params: { threadId: "unknown", cwd: f.dir } };
  const pending = f.session.fromClient(request);
  const inspection = f.server.at(-1)!;
  assert.equal(inspection.method, "thread/read");
  f.session.fromServer({ id: inspection.id, result: { thread: { id: "unknown", model: "fixture-fast", reasoningEffort: "medium" } } });
  await pending;
  f.session.fromServer({ id: 99, result: { thread: { id: "unknown", turns: [{ id: "old", status: "completed" }] }, model: "fixture-fast", cwd: f.dir } });
  const starting = f.request("turn/start", { threadId: "unknown", input: [{ type: "text", text: "继续" }] });
  const history = f.server.at(-1)!;
  assert.equal(history.method, "thread/turns/list");
  f.session.fromServer({ id: history.id, error: { message: "history unavailable" } });
  await starting;
  await assert.rejects(() => readdir(f.cases), /ENOENT/);
});

test("natural followups can lower the route after completion while active turns retain their lease and constraints", async t => {
  const views: TaskView[] = [];
  let answer = classification({ scope: "cross_system", reasoning: "architecture" });
  const f = await fixture(t, async view => { views.push(structuredClone(view)); return answer; });
  const first = f.accept(await f.start("比较订单、支付、库存的一致性架构，不能共享数据库"));
  answer = classification({ relation: "continue", reasoning: "mechanical" });
  await f.start("把方案整理成三点，不增加分析");
  assert.equal(f.server.at(-1)!.params.model, "fixture-deep");
  assert.equal(views.length, 1);
  f.complete(first);
  const summary = await f.start("把方案整理成三点，不增加分析");
  assert.equal(f.server.at(-1)!.params.model, "fixture-fast");
  assert.equal(f.server.at(-1)!.params.effort, "low");
  assert.deepEqual(views.at(-1)!.currentTask.messages, ["比较订单、支付、库存的一致性架构，不能共享数据库"]);
  f.complete(f.accept(summary));
  assert.deepEqual(f.records.load("thread")!.task.messages, ["比较订单、支付、库存的一致性架构，不能共享数据库", "把方案整理成三点，不增加分析"]);
  answer = classification({ relation: "correction", scope: "cross_system", reasoning: "diagnosis", uncertainty: "unknown_cause" });
  await f.start("三个服务的补偿反复失败，请排查根因");
  assert.equal(f.server.at(-1)!.params.model, "fixture-deep");
  assert.equal(f.server.at(-1)!.params.effort, "high");
});

test("curl followups lower an expert route despite ambiguity between ordinary work labels", async t => {
  let answer = classification({ scope: "cross_system", reasoning: "architecture" });
  const f = await fixture(t, async () => answer);
  f.complete(f.accept(await f.start("设计两个 agent 之间的调用方案")));
  // Recorded Jev answer for: 给我两个可以直接在 teminal 里运行的 curl.
  answer = {
    model: "typesafe-ai/jev", inputTokens: 7754, confidence: 0.44,
    features: { relation: "continue", scope: "local", reasoning: "mechanical", uncertainty: "sufficient", consequence: "reversible" },
    questionScores: {
      relation: { confidence: 0.98, probabilities: { continue: 0.98, new: 0.01, uncertain: 0, correction: 0.01 } },
      scope: { confidence: 0.75, probabilities: { cross_system: 0.16, multifile: 0, local: 0.84 } },
      reasoning: { confidence: 0.44, probabilities: { diagnosis: 0, architecture: 0, solution: 0.42, mechanical: 0.58 } },
      uncertainty: { confidence: 0.9, probabilities: { unknown_cause: 0, missing: 0.06, sufficient: 0.94 } },
      consequence: { confidence: 0.56, probabilities: { reversible: 0.71, contract: 0.29, sensitive: 0 } },
    },
  };
  const request = await f.start("给我两个可以直接在 teminal 里运行的 curl");
  assert.equal(f.server.at(-1)!.params.model, "fixture-fast");
  assert.equal(f.server.at(-1)!.params.effort, "medium");
  f.complete(f.accept(request));
  assert.equal(f.events.findLast(e => e.type === "accepted")!.reason, "classified");
  answer = classification({ relation: "continue", reasoning: "mechanical" });
  await f.start("按刚才的接口抄出两条命令，不增加逻辑");
  assert.equal(f.server.at(-1)!.params.effort, "low");
});

test("completed work can downgrade despite ambiguity between known task relations", async t => {
  const cases = [
    { name: "summary after implementation", previous: { reasoning: "solution" as const },
      text: "把现有结论整理成两句话，不再修改或分析。",
      relation: { confidence: 0.51, probabilities: { new: 0.37, continue: 0.63, correction: 0, uncertain: 0 } } },
    { name: "summary after sensitive work", previous: { consequence: "sensitive" as const },
      text: "只总结刚才的文件整理规则，不再执行文件操作。",
      relation: { confidence: 0.39, probabilities: { new: 0.45, continue: 0.54, correction: 0.01, uncertain: 0 } } },
  ];
  for (const row of cases) await t.test(row.name, async t => {
    let answer = classification({ scope: "cross_system", ...row.previous });
    const f = await fixture(t, async () => answer);
    f.complete(f.accept(await f.start("完成上一阶段的工作")));
    answer = classification({ relation: "continue", reasoning: "mechanical" });
    Object.assign(answer.questionScores.relation, row.relation);
    answer.confidence = row.relation.confidence;
    const request = await f.start(row.text);
    assert.equal(f.server.at(-1)!.params.model, "fixture-fast");
    assert.equal(f.server.at(-1)!.params.effort, "low");
    f.accept(request);
    const event = f.events.findLast(e => e.type === "accepted")!;
    assert.equal(event.reason, "classified");
    assert.deepEqual(event.held, []);
    assert.deepEqual(f.records.load("thread")!.task.messages, ["完成上一阶段的工作", row.text]);
  });
});

test("native followups decide model and effort independently and preserve relevant uncertainty", async t => {
  type Distributions = Partial<{ [K in keyof QuestionScores]: QuestionScores[K]["probabilities"] }>;
  const cases: { name: string; features?: Partial<Features>; probabilities?: Distributions; model: string; effort: string; held: string[] }[] = [
    { name: "local versus multifile work still uses the main model", probabilities: {
      scope: { local: 0.45, multifile: 0.4, cross_system: 0.15 },
    }, model: "fixture-fast", effort: "medium", held: [] },
    { name: "uncertain model scope does not hold ordinary effort", features: { scope: "cross_system" }, probabilities: {
      scope: { local: 0.45, multifile: 0, cross_system: 0.55 },
    }, model: "fixture-deep", effort: "medium", held: ["model"] },
    { name: "uncertain reasoning depth does not hold the expert model", probabilities: {
      reasoning: { solution: 0.6, diagnosis: 0.4, architecture: 0, mechanical: 0 },
    }, model: "fixture-fast", effort: "high", held: ["effort"] },
    { name: "diagnosis versus architecture still needs high effort", features: { reasoning: "diagnosis" }, probabilities: {
      reasoning: { diagnosis: 0.5, architecture: 0.5, solution: 0, mechanical: 0 },
    }, model: "fixture-fast", effort: "high", held: [] },
    { name: "an unknown fault still needs high effort", features: { uncertainty: "unknown_cause" },
      model: "fixture-fast", effort: "high", held: [] },
    { name: "sensitive implementation still needs high effort", features: { consequence: "sensitive" },
      model: "fixture-fast", effort: "high", held: [] },
    { name: "unclear task references keep both floors", features: { relation: "uncertain" },
      model: "fixture-deep", effort: "high", held: ["model", "effort"] },
    { name: "missing requirements keep both floors", features: { uncertainty: "missing" },
      model: "fixture-deep", effort: "high", held: ["model", "effort"] },
    { name: "material unresolved reference probability keeps both floors", probabilities: {
      relation: { new: 0.1, continue: 0.5, correction: 0.1, uncertain: 0.3 },
    }, model: "fixture-deep", effort: "high", held: ["model", "effort"] },
    { name: "ambiguity among known relations does not hold either floor", probabilities: {
      relation: { new: 0.2, continue: 0.45, correction: 0.35, uncertain: 0 },
    }, model: "fixture-fast", effort: "medium", held: [] },
    { name: "a self-contained new task does not inherit an uncertain old model", features: { relation: "new", scope: "cross_system" }, probabilities: {
      scope: { local: 0.45, multifile: 0, cross_system: 0.55 },
    }, model: "fixture-fast", effort: "medium", held: ["model"] },
  ];
  for (const row of cases) await t.test(row.name, async t => {
    let answer = classification({ scope: "cross_system", reasoning: "architecture" });
    const f = await fixture(t, async () => answer);
    f.complete(f.accept(await f.start("设计跨系统调用方案")));
    answer = classification({ relation: "continue", reasoning: "solution", ...row.features });
    for (const key of Object.keys(row.probabilities ?? {}) as (keyof QuestionScores)[]) {
      const probabilities = row.probabilities![key]!;
      const n = Object.keys(probabilities).length;
      Object.assign(answer.questionScores[key], { probabilities, confidence: (Math.max(...Object.values(probabilities)) - 1 / n) / (1 - 1 / n) });
    }
    answer.confidence = Math.min(...Object.values(answer.questionScores).map(q => q.confidence));
    f.accept(await f.start("当前阶段的明确请求"));
    assert.equal(f.server.at(-1)!.params.model, row.model);
    assert.equal(f.server.at(-1)!.params.effort, row.effort);
    const event = f.events.findLast(e => e.type === "accepted")!;
    assert.deepEqual(event.held, row.held);
    assert.equal(event.reason, row.held.length ? "low-confidence" : "classified");
  });
});

test("changing the routing policy does not invalidate an aligned saved task", async t => {
  const f = await fixture(t, async () => classification({ reasoning: "diagnosis" }));
  const turnId = f.accept(await f.start("保留审计约束")); f.complete(turnId); f.session.close();
  const changed = config(); changed.semantic!.minConfidence = 0.8;
  let view: TaskView | undefined;
  const server: NativeMessage[] = [];
  const session = new NativeSession(changed, f.records, m => server.push(m), () => {}, () => {}, async v => {
    view = v; return classification({ relation: "continue", reasoning: "mechanical" });
  }); f.sessions.push(session);
  await session.fromClient({ id: 100, method: "thread/resume", params: { threadId: "thread" } });
  session.fromServer({ id: 100, result: { thread: { id: "thread", turns: [{ id: turnId, status: "completed" }] }, model: "fixture-fast", reasoningEffort: "high" } });
  assert.equal(f.records.load("thread")!.task.incomplete, false);
  await session.fromClient({ id: 101, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: "将刚才的约束抄成一条清单" }] } });
  assert.deepEqual(view?.currentTask.messages, ["保留审计约束"]);
  assert.equal(server.at(-1)!.params.effort, "low");
});

test("unknown resume hydrates paginated native user and tool history without including reasoning", async t => {
  const f = await fixture(t, async () => classification()); f.session.close();
  const server: NativeMessage[] = [], views: TaskView[] = [];
  const session = new NativeSession(config(), f.records, message => {
    server.push(message);
    if (typeof message.id !== "string") return;
    const result = message.method === "thread/read" ? { thread: { model: "fixture-fast", reasoningEffort: "high" } } :
      message.params.cursor ? { data: [{ id: "old", status: "completed", itemsView: "full", items: [
        { type: "userMessage", content: [{ type: "text", text: "订单、支付、库存不能共享数据库" }] },
        { type: "reasoning", content: ["PRIVATE_THOUGHT"] },
      ] }], nextCursor: null } : { data: [{ id: "latest", status: "completed", itemsView: "full", items: [
        { type: "userMessage", content: [{ type: "text", text: "排查补偿失败" }] },
        { type: "commandExecution", command: "test", exitCode: 1, aggregatedOutput: "补偿重试失败" },
        { type: "agentMessage", phase: "final_answer", text: "失败原因待查" },
      ] }], nextCursor: "older" };
    queueMicrotask(() => session.fromServer({ id: message.id, result }));
  }, () => {}, () => {}, async view => { views.push(view); return classification({ relation: "continue", scope: "cross_system", reasoning: "diagnosis" }); });
  f.sessions.push(session);
  await session.fromClient({ id: 100, method: "thread/resume", params: { threadId: "unknown", excludeTurns: true } });
  session.fromServer({ id: 100, result: { thread: { id: "unknown", turns: [] }, model: "fixture-fast", reasoningEffort: "high" } });
  await session.fromClient({ id: 101, method: "turn/start", params: { threadId: "unknown", input: [{ type: "text", text: "继续排查补偿失败的根因" }] } });
  assert.equal(views.length, 1);
  assert.deepEqual(views[0]!.currentTask.messages, ["订单、支付、库存不能共享数据库", "排查补偿失败"]);
  assert.equal(views[0]!.currentTask.incomplete, false);
  assert.match(JSON.stringify(views[0]!.currentTask.evidence), /补偿重试失败/);
  assert.doesNotMatch(JSON.stringify(views), /PRIVATE_THOUGHT/);
  assert.equal(server.at(-1)!.params.model, "fixture-deep");
  assert.equal(server.filter(m => m.method === "thread/turns/list").length, 2);
});

test("missing history can classify self-contained requests and recover naturally after uncertainty or classifier failure", async t => {
  const f = await fixture(t, async () => classification()); f.session.close();
  let answer: ReturnType<typeof classification> | Error = classification({ relation: "uncertain", uncertainty: "missing" });
  const views: TaskView[] = [], server: NativeMessage[] = [];
  const session = new NativeSession(config(), f.records, message => {
    server.push(message);
    if (typeof message.id !== "string") return;
    queueMicrotask(() => session.fromServer(message.method === "thread/read" ?
      { id: message.id, result: { thread: { model: "fixture-fast", reasoningEffort: "high" } } } :
      { id: message.id, error: { message: "history unavailable" } }));
  }, () => {}, () => {}, async view => {
    views.push(structuredClone(view)); if (answer instanceof Error) throw answer; return answer;
  }); f.sessions.push(session);
  await session.fromClient({ id: 100, method: "thread/resume", params: { threadId: "unknown", excludeTurns: true } });
  session.fromServer({ id: 100, result: { thread: { id: "unknown", turns: [] }, model: "fixture-fast", reasoningEffort: "high" } });
  let id = 100;
  const run = async (text: string) => {
    const requestId = ++id;
    await session.fromClient({ id: requestId, method: "turn/start", params: { threadId: "unknown", input: [{ type: "text", text }] } });
    const request = server.at(-1)!;
    session.fromServer({ id: requestId, result: { turn: { id: `turn-${requestId}` } } });
    session.fromServer({ method: "turn/completed", params: { threadId: "unknown", turn: { id: `turn-${requestId}`, status: "completed" } } });
    return request.params;
  };
  assert.equal((await run("修复刚才那个问题")).effort, "high");
  assert.equal(views.length, 1);
  assert.equal(views[0]!.currentTask.incomplete, true);
  answer = new ClassificationError("timeout");
  assert.equal((await run("请重新评估")).effort, "high");
  answer = classification({ scope: "cross_system", reasoning: "architecture" });
  assert.equal((await run("比较订单、支付、库存三个独立服务的一致性架构，不能共享数据库")).model, "fixture-deep");
  assert.equal(f.records.load("unknown")!.task.incomplete, false);
  answer = classification({ relation: "continue", reasoning: "mechanical" });
  assert.equal((await run("把上面的方案整理成三点，不增加分析")).effort, "low");
});

test("large prior evidence does not block a small new turn or erase persisted task constraints", async t => {
  let view: TaskView | undefined;
  const f = await fixture(t, async v => { view = v; return classification({ relation: "continue", reasoning: "mechanical" }); });
  const first = f.accept(await f.start("保留审计约束"));
  f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: first,
    item: { type: "commandExecution", id: "large", command: "test", exitCode: 0, aggregatedOutput: "output ".repeat(10000) } } });
  f.complete(first);
  await f.start("抄出审计约束，不增加分析");
  assert.ok(view); assert.equal(view.currentTask.incomplete, true);
  assert.deepEqual(view.currentTask.messages, ["保留审计约束"]);
  assert.match(view.currentTask.evidence[0]!, /"exitCode":0/);
  assert.match(view.currentTask.evidence[0]!, /Fenjue: omitted/);
  assert.match(f.records.load("thread")!.task.evidence[0]!, /output/);
  assert.equal(f.server.at(-1)!.params.effort, "low");
});

test("budgeted classification retains the conclusion of a long completed answer without changing execution history", async t => {
  const views: TaskView[] = [];
  const f = await fixture(t, async view => { views.push(structuredClone(view)); return classification({ relation: "continue", reasoning: "mechanical" }); });
  const first = f.accept(await f.start("修复导出目录限制，允许选择任意目录"));
  const conclusion = "根因已定位：列表接口过滤了工作目录。方案已确认：移除目录过滤，保留权限检查。";
  const answer = "已检查源代码。\n" + "工具检查输出\n".repeat(10000) + conclusion;
  f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: first,
    item: { type: "agentMessage", id: "long-answer", phase: "final_answer", text: answer } } });
  f.complete(first);
  await f.start("按刚才确定的方案修改，不再排查原因");
  const selected = views.at(-1)!;
  assert.ok(selected.currentTask.evidence.some(e => e.includes(conclusion)), "last conclusion must reach the classifier");
  assert.equal(selected.currentTask.incomplete, true);
  assert.deepEqual(f.records.load("thread")!.task.evidence, [answer], "full execution evidence must stay intact");
  assert.equal(f.server.at(-1)!.params.effort, "low");
});

test("classification budget keeps the original goal and recent request when middle history overflows", async t => {
  let selected: TaskView | undefined;
  const f = await fixture(t, async view => { selected = structuredClone(view); return classification({ relation: "continue" }); });
  const goal = "只修改内部实现，必须保留公开协议和审计记录";
  const first = f.accept(await f.start(goal));
  for (let i = 0; i < 60; i++) f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: first,
    item: { type: "userMessage", id: `steer-${i}`, content: [{ type: "text", text: `补充材料 ${i}: ` + "已讨论的背景资料。".repeat(80) }] } } });
  f.complete(first);
  await f.start("按原先的约束整理结论");
  assert.equal(selected!.currentTask.messages[0], goal);
  assert.match(selected!.currentTask.messages.at(-1)!, /补充材料 59/);
  assert.equal(selected!.currentTask.incomplete, true);
  assert.equal(f.records.load("thread")!.task.messages.length, 61);
});

test("an implementation followup cannot inherit low effort solely because consequence confidence is weak", async t => {
  const f = await fixture(t, async view => {
    if (view.newMessages[0] === "查询机器型号") return classification({ reasoning: "mechanical" });
    const result = classification({ relation: "continue", reasoning: "solution" });
    return { ...result, questionScores: { ...result.questionScores,
      consequence: { confidence: 0.66, probabilities: { reversible: 0.66, contract: 0, sensitive: 0.34 } } } };
  });
  const lookup = f.accept(await f.start("查询机器型号")); f.complete(lookup);
  assert.equal(f.server.findLast(m => m.method === "turn/start")!.params.effort, "low");
  f.accept(await f.start("实际部署已选择的程序"));
  assert.equal(f.server.at(-1)!.params.effort, "medium");
  assert.equal(f.events.findLast(e => e.type === "accepted")!.reason, "low-confidence");
});

test("cancelling native history recovery cancels the pending turn without calling the classifier", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return classification(); });
  const rollback = await f.request("thread/rollback", { threadId: "thread", numTurns: 1 });
  f.session.fromServer({ id: rollback.id, result: {} });
  const pending = f.start("比较跨系统架构");
  assert.equal(f.server.at(-1)!.method, "thread/turns/list");
  const inspectionId = f.server.at(-1)!.id;
  await f.request("turn/interrupt", { threadId: "thread", turnId: "not-started" });
  await pending;
  assert.equal(calls, 0);
  assert.equal(f.server.filter(m => m.method === "turn/start").length, 0);
  const replies = f.client.length;
  f.session.fromServer({ id: inspectionId, result: { data: [], nextCursor: null } });
  assert.equal(f.client.length, replies, "Late inspection responses must not reach the TUI");
  f.complete(f.accept(await f.start("[new] 将 hello 改成大写")));
  const next = f.start("将 world 改成大写");
  assert.equal(f.server.filter(m => m.method === "thread/turns/list").length, 1, "An accepted new task must discard pending recovery of old history");
  await next;
});

test("native explicit routes validate capability without changing the Responses route pool", () => {
  const c = config(), original = structuredClone(c.routes);
  c.native!.rules = [{ prefix: "[sol-xhigh]", model: "fixture-fast", effort: "xhigh" },
    { prefix: "[astra-xhigh]", model: "fixture-deep", effort: "xhigh" }];
  assert.deepEqual(parseConfig(c).routes, original);
  assert.throws(() => validateNativeCatalog(models(), c), /fixture-fast \/ xhigh/);
  const catalog = models();
  for (const model of catalog.models) model.supported_reasoning_levels = ["low", "medium", "high", "xhigh"].map(effort => ({ effort, description: "" }));
  validateNativeCatalog(catalog, c);
  catalog.models[1]!.supported_reasoning_levels = ["medium", "high", "xhigh"].map(effort => ({ effort, description: "" }));
  assert.throws(() => validateNativeCatalog(catalog, c), /fixture-deep \/ low/);
  for (const rules of [null, {}, [{ prefix: "", model: "fixture-fast", effort: "xhigh" }],
    [{ prefix: "[xhigh]", model: "fenjue-auto", effort: "xhigh" }],
    [{ prefix: "[xhigh]", model: "fixture-fast", effort: "unknown" }]]) {
    assert.throws(() => parseConfig({ ...c, native: { ...c.native, rules } }), /native.rules/);
  }
});

test("explicit native xhigh preserves Plan, active leases and restored continuation, then resumes stage routing", async t => {
  for (const [prefix, model] of [["[sol-xhigh]", "fixture-fast"], ["[astra-xhigh]", "fixture-deep"]] as const) {
    const c = config(); c.native!.rules = [{ prefix, model, effort: "xhigh" }];
    let calls = 0;
    const classify: Classify = async () => { calls++; return classification({ relation: "continue", reasoning: "mechanical", scope: "cross_system" }); };
    const f = await fixture(t, classify, false, c);
    const first = await f.start(`${prefix} 核对复杂方案`, { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" },
      collaborationMode: { mode: "plan", settings: { model: "fixture-fast", reasoning_effort: "medium", developer_instructions: "retain" } } });
    assert.equal(calls, 0);
    assert.deepEqual(f.server.at(-1)!.params.collaborationMode.settings, { model, reasoning_effort: "xhigh", developer_instructions: "retain" });
    assert.equal(f.server.at(-1)!.params.approvalPolicy, "never");
    const turn = f.accept(first);
    await f.start("执行中补充说明");
    assert.equal(f.server.at(-1)!.params.model, model); assert.equal(f.server.at(-1)!.params.effort, "xhigh");
    f.complete(turn); f.session.close();
    const next = new NativeSession(c, f.records, m => f.server.push(structuredClone(m)), m => f.client.push(m),
      e => f.events.push(e), classify); f.sessions.push(next);
    await next.fromClient({ id: "resume-xhigh", method: "thread/resume", params: { threadId: "thread" } });
    assert.equal(f.server.at(-1)!.params.model, model);
    assert.equal(f.server.at(-1)!.params.config.model_reasoning_effort, "xhigh");
    next.fromServer({ id: "resume-xhigh", result: { thread: { id: "thread", turns: [{ id: turn }] }, model, reasoningEffort: "xhigh" } });
    const run = async (id: string, text: string) => {
      await next.fromClient({ id, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text }] } });
      const sent = f.server.at(-1)!;
      next.fromServer({ id, result: { turn: { id, status: "inProgress" } } });
      next.fromServer({ method: "turn/completed", params: { threadId: "thread", turn: { id, status: "completed", items: [] } } });
      return sent.params;
    };
    assert.equal((await run("continue-xhigh", "继续")).effort, "xhigh"); assert.equal(calls, 0);
    const simple = await run("summarize-xhigh", "按已定字段整理两份服务配置，不增加分析");
    assert.equal(simple.model, "fixture-deep"); assert.equal(simple.effort, "low"); assert.equal(calls, 1);
  }
});

test("manual and shadow modes retain user execution choices despite native xhigh prefixes", async t => {
  for (const mode of ["manual", "shadow"] as const) {
    const c = config(); c.native!.rules = [{ prefix: "[astra-xhigh]", model: "fixture-deep", effort: "xhigh" }];
    const f = await fixture(t, async () => { assert.fail("prefix must not invoke classifier"); }, false, c);
    f.session.setMode(mode);
    const first = await f.start("[astra-xhigh] 评估方案");
    assert.equal(f.server.at(-1)!.params.model, "fixture-fast"); assert.equal(f.server.at(-1)!.params.effort, "medium");
    f.complete(f.accept(first));
    if (mode === "shadow") assert.deepEqual(f.records.load("thread")!.suggestion, { model: "fixture-deep", effort: "xhigh" });
  }
});
