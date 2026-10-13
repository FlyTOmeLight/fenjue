import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClassifier, createDemandClassifier, classifierUsage, ClassificationError, type ClassifyDemand, type ClassificationObservation } from "../src/classification.js";
import { NativeSession, type NativeMessage } from "../src/native-session.js";
import { NativeRecords, type NativeEvent } from "../src/native-records.js";
import { observedTasks, addFeedback, iterationReport } from "../src/feedback.js";
import { parseConfig } from "../src/config.js";
import { NativeRouteStatus } from "../src/status.js";
import { routingCalls, routingCost } from "../src/routing-observations.js";
import { classification, jevResponse, semanticConfig, serve, readJSON } from "./fixtures.js";

const view = { currentTask: { messages: [], evidence: [], incomplete: false }, newMessages: ["查询多个来源并核对结果，再计算差异"], evidence: [], incomplete: false };
const demandResponse = { model: "jev-1.13.0", usage: { input_tokens: 50, output_tokens: 10 }, answers: { demand: {
  type: "choice", choice: "multi_step", confidence: 0.9, probabilities: { routine: 0.1, multi_step: 0.9, complex: 0 },
} } };

test("independent demand request has one question, validates scores and retains actual failure usage", async () => {
  const config = semanticConfig().semantic!;
  const observations: ClassificationObservation[] = [];
  const classify = createDemandClassifier(config, "fixture", async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    assert.deepEqual(Object.keys(body.questions), ["demand"]);
    assert.deepEqual(body.state, view);
    return Response.json(demandResponse);
  });
  assert.equal((await classify(view, new AbortController().signal, o => observations.push(o))).suggestedEffort, "medium");
  assert.equal(observations.at(-1)!.usage.total, 60);
  const bad = createDemandClassifier(config, "fixture", async () => Response.json({ ...demandResponse,
    answers: { demand: { ...demandResponse.answers.demand, probabilities: { routine: 0.9, multi_step: 0.9, complex: 0 } } } }));
  await assert.rejects(() => bad(view, new AbortController().signal, o => observations.push(o)), /invalid-response/);
  assert.equal(observations.at(-1)!.usage.total, 60);
  const budget = createDemandClassifier({ ...config, maxInputBytes: 1 }, "fixture", async () => assert.fail("must not send"));
  await assert.rejects(() => budget(view, new AbortController().signal, o => observations.push(o)), /input-budget/);
  assert.equal(observations.at(-1)!.httpAttempted, false);
  assert.equal(observations.at(-1)!.usage.total, null);
});

test("baseline questions remain five and usage is recorded before invalid classification fails", async () => {
  const observations: ClassificationObservation[] = [];
  const classify = createClassifier(semanticConfig().semantic!, "fixture", async (_url, init) => {
    assert.equal(Object.keys(JSON.parse(String(init!.body)).questions).length, 5);
    return Response.json({ ...jevResponse(), usage: { input_tokens: 100, output_tokens: 20 }, answers: {} });
  });
  await assert.rejects(() => classify(view, new AbortController().signal, o => observations.push(o)), /invalid-response/);
  assert.deepEqual(observations.at(-1)!.usage, { input: 100, output: 20, total: 120, cachedInput: null, reasoning: null });
  assert.equal(classifierUsage({ input_tokens: 100 }).total, null);
});

async function fixture(t: any, demand: ClassifyDemand, enabled: boolean | "auto" = true, result = classification()) {
  const dir = await mkdtemp(join(tmpdir(), "fenjue-demand-")), events: NativeEvent[] = [], server: NativeMessage[] = [];
  const config = semanticConfig(); config.routes.deep = { model: "fixture-fast", effort: "high" };
  config.native = enabled ? { reasoningDemand: enabled === "auto" ? "auto" : "shadow" } : {};
  const records = new NativeRecords(dir, undefined, [], msg => assert.fail(msg));
  const session = new NativeSession(config, records, m => server.push(m), () => {}, e => events.push(e), async (_v, _s, observe) => {
    observe?.({ httpAttempted: true, usage: classifierUsage({ input_tokens: 100, output_tokens: 20 }) });
    return result;
  }, false, demand);
  t.after(async () => { session.close(); await rm(dir, { recursive: true, force: true }); });
  await session.fromClient({ id: 1, method: "thread/start", params: { threadSource: "user", cwd: dir } });
  session.fromServer({ id: 1, result: { thread: { id: "thread" }, model: "fixture-fast", reasoningEffort: "medium" } });
  const start = () => session.fromClient({ id: 2, method: "turn/start", params: { threadId: "thread", model: "fixture-fast", effort: "medium", input: [{ type: "text", text: view.newMessages[0] }] } });
  return { dir, session, events, server, start };
}

test("shadow cannot delay or alter the accepted route; frozen input and call IDs join feedback and costs", async t => {
  let resolve!: (v: any) => void, shadowInput: any;
  const pending = new Promise<any>(r => { resolve = r; });
  const f = await fixture(t, async (input, _signal, observe) => {
    shadowInput = input;
    observe?.({ httpAttempted: true, usage: classifierUsage({ input_tokens: 50, output_tokens: 10 }) });
    return pending;
  });
  await f.start();
  const request = f.server.find(m => m.method === "turn/start")!;
  assert.equal(request.params.effort, "low");
  f.session.fromServer({ id: request.id, result: { turn: { id: "turn" } } });
  const inFlightCost = routingCost(await routingCalls(f.dir));
  assert.equal(inFlightCost.pending, 1);
  assert.equal(inFlightCost.usage.total, null);
  const accepted = f.events.find(e => e.type === "accepted")!;
  assert.equal(typeof accepted.decisionId, "string");
  assert.equal((accepted.classifierCalls as any[]).length, 1);
  assert.equal(f.events.some(e => e.type === "demand-shadow"), false);
  f.session.fromServer({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "future", type: "agentMessage", text: "Future answer" } } });
  assert.equal(JSON.stringify(shadowInput).includes("Future answer"), false);
  resolve({ model: "jev-1.13.0", demand: demandResponse.answers.demand, suggestedEffort: "high" });
  await new Promise<void>(r => setImmediate(r));
  assert.equal(f.events.find(e => e.type === "demand-shadow")!.decisionId, accepted.decisionId);
  const calls = await routingCalls(f.dir);
  assert.equal(calls.length, 2);
  assert.equal(routingCost(calls).usage.total, 180);
  const tasks = await observedTasks(f.dir);
  assert.equal(tasks[0]!.turns[0]!.decisionId, accepted.decisionId);
  await assert.rejects(() => addFeedback(f.dir, { taskId: String(accepted.taskId), outcome: "accepted", cause: "unknown", reviewer: "human", reason: "verified", routing: { demand: "multi_step" } }), /turnId/);
  await addFeedback(f.dir, { taskId: String(accepted.taskId), turnId: "turn", outcome: "accepted", cause: "unknown", reviewer: "human", reason: "verified", routing: { demand: "multi_step", assessment: "insufficient", switchCause: "quality" } });
  assert.equal((await observedTasks(f.dir))[0]!.feedback[0]!.routing!.demand, "multi_step");
  const report = iterationReport(await observedTasks(f.dir), 7, new Date(), calls);
  assert.equal(report.summary.humanDemandMatches, 1);
  assert.equal(report.summary.demandEffortDifferences, 1);
  assert.deepEqual(report.summary.stages, { mechanical: 1 });
  assert.equal(report.routing.classification!.usage.total, 120);
  assert.equal(report.routing.demandShadow!.usage.total, 60);
});

test("shadow failure stays observable and session close cancels pending shadow work", async t => {
  const f = await fixture(t, async (_v, _s, observe) => {
    observe?.({ httpAttempted: true, usage: classifierUsage(null) });
    throw new ClassificationError("timeout");
  });
  await f.start(); await new Promise<void>(r => setImmediate(r));
  assert.equal(f.server.find(m => m.method === "turn/start")!.params.effort, "low");
  assert.equal((await routingCalls(f.dir)).find(c => c.phase === "demand-shadow")!.error, "timeout");
  let aborted = false;
  const running = await fixture(t, async (_v, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  await running.start(); running.session.close();
  await new Promise<void>(r => setImmediate(r));
  assert.equal(aborted, true);
  const disabled = await fixture(t, async () => assert.fail("disabled shadow must not call"), false);
  await disabled.start();
  assert.equal(disabled.events.some(e => e.type === "demand-shadow"), false);
});

test("report keeps unknown use unknown, deduplicates calls and includes rejected decision cost", async t => {
  const f = await fixture(t, async () => assert.fail(), false);
  await f.start();
  const calls = await routingCalls(f.dir);
  const report = iterationReport([], 7, new Date(), calls);
  assert.equal(report.routing.unacceptedCalls, 1);
  assert.equal(report.routing.classification!.usage.total, 120);
  assert.equal(report.summary.endToEndObservedTokens, null);
  assert.equal(routingCost([{ ...calls[0]!, usage: classifierUsage(null) }]).usage.total, null);
  const path = join(f.dir, "native-9-9.jsonl");
  await writeFile(path, JSON.stringify({ type: "classification-call", ...calls[0] }) + "\n");
  assert.equal((await routingCalls(f.dir)).length, 1);
  assert.match(await readFile(path, "utf8"), /callId/);
});

test("background observations never replace the user-visible active route", () => {
  const status = new NativeRouteStatus();
  status.update({ type: "accepted", threadId: "thread", mode: "auto", route: { model: "main", effort: "low" } });
  const line = status.line();
  for (const type of ["classification-call", "classification-started", "demand-shadow"]) {
    assert.equal(status.update({ type, threadId: "thread", route: { model: "other", effort: "high" } }), false);
    assert.equal(status.line(), line);
  }
});

test("new-task boundary counts both baseline calls, one shadow, and preserves manual switch provenance", async t => {
  const inputs: any[] = [];
  const f = await fixture(t, async (input, _signal, observe) => {
    inputs.push(input);
    observe?.({ httpAttempted: true, usage: classifierUsage({ input_tokens: 50, output_tokens: 10 }) });
    return { model: "jev-1.13.0", demand: demandResponse.answers.demand as any, suggestedEffort: "medium" };
  });
  await f.start();
  f.session.fromServer({ id: 2, result: { turn: { id: "first" } } });
  f.session.fromServer({ method: "turn/completed", params: { threadId: "thread", turn: { id: "first", status: "completed", items: [] } } });
  await f.session.fromClient({ id: 3, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: "开始另一个独立任务" }] } });
  f.session.fromServer({ id: 3, result: { turn: { id: "second" } } });
  await new Promise<void>(r => setImmediate(r));
  const accepted = f.events.filter(e => e.type === "accepted").at(-1)!;
  assert.deepEqual((accepted.classifierCalls as any[]).map(c => c.phase), ["initial", "new-task"]);
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[1].currentTask.messages, []);
  assert.equal((await routingCalls(f.dir)).length, 5);
  await f.session.fromClient({ id: 4, method: "thread/settings/update", params: { threadId: "thread", model: "fixture-fast", effort: "high" } });
  f.session.fromServer({ id: 4, result: {} });
  const mode = f.events.find(e => e.reason === "native-model-picker")!;
  assert.deepEqual(mode.fromRoute, { model: "fixture-fast", effort: "low" });
  assert.deepEqual(mode.toRoute, { model: "fixture-fast", effort: "high" });
  assert.equal((await observedTasks(f.dir)).find(t => t.taskId === accepted.taskId)!.interventions!.length, 1);
});

test("reasoning demand configuration enables auto and shadow", () => {
  const config = semanticConfig();
  assert.equal(parseConfig({ ...config, native: { reasoningDemand: "auto" } }).native!.reasoningDemand, "auto");
  assert.throws(() => parseConfig({ ...config, native: { reasoningDemand: "other" } }), /auto.*shadow/);
  assert.equal(parseConfig({ ...config, native: { reasoningDemand: "shadow" } }).native!.reasoningDemand, "shadow");
});


test("integrated demand upgrades complex implementation in one classification and pins active turns", async t => {
  const result = { ...classification({ reasoning: "solution", scope: "multifile" }),
    demand: { choice: "complex" as const, confidence: 0.9, probabilities: { routine: 0.02, multi_step: 0.08, complex: 0.9 } } };
  const f = await fixture(t, async () => assert.fail("auto must not make a shadow request"), "auto", result);
  await f.start();
  const request = f.server.find(m => m.method === "turn/start")!;
  assert.equal(request.params.model, "fixture-fast");
  assert.equal(request.params.effort, "high");
  f.session.fromServer({ id: request.id, result: { turn: { id: "turn" } } });
  const accepted = f.events.find(e => e.type === "accepted")!;
  assert.equal((accepted.classification as any).demand.choice, "complex");
  assert.equal((accepted.effortDecision as any).reason, "demand");
  assert.equal((accepted.classifierCalls as any[]).length, 1);
  assert.equal((await routingCalls(f.dir)).length, 1);
  assert.equal(routingCost(await routingCalls(f.dir)).usage.total, 120);
  await f.session.fromClient({ id: 3, method: "turn/start", params: {
    threadId: "thread", effort: "low", input: [{ type: "text", text: "补充一个要求" }] } });
  assert.equal(f.server.find(m => m.id === 3)!.params.effort, "high");
  assert.equal(f.events.filter(e => e.type === "classification-call").length, 1);
  f.session.fromServer({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } } });
  result.features = { ...result.features, relation: "continue", reasoning: "mechanical" };
  result.questionScores.reasoning.probabilities = { mechanical: 1, solution: 0, diagnosis: 0, architecture: 0 };
  result.demand = { choice: "routine" as any, confidence: 1, probabilities: { routine: 1, multi_step: 0, complex: 0 } };
  await f.session.fromClient({ id: 4, method: "turn/start", params: {
    threadId: "thread", input: [{ type: "text", text: "只列出已完成的技能名称" }] } });
  assert.equal(f.server.find(m => m.id === 4)!.params.effort, "low");
});


test("native auto sends the demand question through the real adapter and preserves the route on malformed scores", async t => {
  let calls = 0, valid = true;
  const response = jevResponse(classification({ reasoning: "solution" }));
  const upstream = await serve(async (req, res) => {
    const body = await readJSON(req); calls++;
    assert.equal(Object.keys(body.questions).length, 6);
    assert.ok(body.questions.demand);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...response, answers: { ...response.answers, ...(valid ? { demand: {
      type: "choice", choice: "complex", confidence: 0.9,
      probabilities: { routine: 0.02, multi_step: 0.08, complex: 0.9 },
    } } : {}) } }));
  });
  const dir = await mkdtemp(join(tmpdir(), "fenjue-demand-adapter-"));
  const config = semanticConfig();
  config.routes.deep = { model: "fixture-fast", effort: "high" };
  config.native = { reasoningDemand: "auto" };
  config.semantic!.endpoint = upstream.url; delete config.semantic!.apiKeyEnv;
  const events: NativeEvent[] = [], server: NativeMessage[] = [];
  const records = new NativeRecords(dir, undefined, [], msg => assert.fail(msg));
  const session = new NativeSession(config, records, m => server.push(m), () => {}, e => events.push(e));
  t.after(async () => { session.close(); await upstream.close(); await rm(dir, { recursive: true, force: true }); });
  await session.fromClient({ id: 1, method: "thread/start", params: { threadSource: "user", cwd: dir } });
  session.fromServer({ id: 1, result: { thread: { id: "thread" }, model: "fixture-fast", reasoningEffort: "medium" } });
  const start = (id: number, text: string) => session.fromClient({ id, method: "turn/start", params: {
    threadId: "thread", input: [{ type: "text", text }] } });
  await start(2, "按总体方案整合规则，解决冲突并确定边界");
  assert.equal(server.find(m => m.id === 2)!.params.effort, "high");
  session.fromServer({ id: 2, result: { turn: { id: "first" } } });
  session.fromServer({ method: "turn/completed", params: { threadId: "thread", turn: { id: "first", status: "completed", items: [] } } });
  valid = false;
  await start(3, "继续核对同一个任务中的规则冲突");
  assert.equal(server.find(m => m.id === 3)!.params.effort, "high");
  session.fromServer({ id: 3, result: { turn: { id: "second" } } });
  assert.equal(events.findLast(e => e.type === "accepted")!.reason, "invalid-response");
  assert.equal(events.some(e => e.type === "demand-shadow"), false);
  assert.equal(calls, 2);
  assert.deepEqual(upstream.errors, []);
});


test("integrated demand respects overall shadow and manual routing modes", async t => {
  const result = { ...classification({ reasoning: "solution" }), demand: {
    choice: "complex" as const, confidence: 1, probabilities: { routine: 0, multi_step: 0, complex: 1 },
  } };
  for (const mode of ["shadow", "manual"] as const) {
    const f = await fixture(t, async () => assert.fail("must not run independent shadow request"), "auto", result);
    f.session.setMode(mode);
    await f.start();
    const request = f.server.find(m => m.method === "turn/start")!;
    assert.equal(request.params.effort, "medium");
    f.session.fromServer({ id: request.id, result: { turn: { id: "turn" } } });
    const accepted = f.events.find(e => e.type === "accepted")!;
    if (mode === "shadow") assert.equal((accepted.suggestion as any).effort, "high");
    else assert.equal(f.events.some(e => e.type === "classification-call"), false);
  }
});
