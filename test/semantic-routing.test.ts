import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Router } from "../src/routing.js";
import { AUTO_MODEL } from "../src/config.js";
import { ClassificationError, type Classification } from "../src/classification.js";
import type { TaskView } from "../src/task-state.js";
import { classification, request, semanticConfig } from "./fixtures.js";

test("model and effort are independent, and ongoing tasks cannot automatically downgrade either", async () => {
  let answer = classification({ scope: "cross_system", reasoning: "solution" });
  const router = new Router(semanticConfig(), async () => answer);
  const first = await router.prepare(request("按接口文档同步两个系统")); first.accept();
  assert.equal(first.decision!.model, "fixture-deep"); assert.equal(first.decision!.effort, "medium");
  answer = classification({ relation: "continue" });
  const follow = await router.prepare(request("顺便改个名字")); follow.accept();
  assert.equal(follow.decision!.model, "fixture-deep"); assert.equal(follow.decision!.effort, "medium");
  answer = classification({ relation: "correction", reasoning: "diagnosis", uncertainty: "unknown_cause" });
  const fix = await router.prepare(request("还是不对")); fix.accept();
  assert.equal(fix.decision!.effort, "high");
  answer = classification();
  const fresh = await router.prepare(request("新任务：把 a 改成 b")); fresh.accept();
  assert.equal(fresh.decision!.route, "fast"); assert.equal(fresh.decision!.effort, "low");
});

test("TaskState carries original goals, constraints and tool evidence into corrections; clear new tasks reset it", async () => {
  const views: TaskView[] = [];
  let answer = classification({ reasoning: "architecture" });
  const router = new Router(semanticConfig(), async view => { views.push(structuredClone(view)); return answer; });
  (await router.prepare(request("设计分布式订单系统；必须保留审计记录"))).accept();
  answer = classification({ relation: "continue", reasoning: "solution" });
  (await router.prepare(request("再加限制：不能修改公共 API"))).accept();
  (await router.prepare({ model: AUTO_MODEL, prompt_cache_key: "thread-1", input: [{ type: "function_call_output", output: "测试失败：订单重复" }] })).accept();
  answer = classification({ relation: "correction", reasoning: "diagnosis" });
  (await router.prepare(request("还是不对，请继续排查"))).accept();
  assert.deepEqual(views.at(-1)!.currentTask.messages, ["设计分布式订单系统；必须保留审计记录", "再加限制：不能修改公共 API"]);
  assert.deepEqual(views.at(-1)!.currentTask.evidence, ["测试失败：订单重复"]);
  answer = classification();
  (await router.prepare(request("另外一个任务：把这句话译成英文"))).accept();
  answer = classification({ relation: "continue" });
  await router.prepare(request("再短一点"));
  assert.deepEqual(views.at(-1)!.currentTask.messages, ["另外一个任务：把这句话译成英文"]);
  assert.deepEqual(views.at(-1)!.currentTask.evidence, []);
});

test("full-history tool calls and short continuations reuse decisions; identical text at different positions is a different turn", async () => {
  let calls = 0;
  const views: TaskView[] = [];
  const router = new Router(semanticConfig(), async view => { calls++; views.push(structuredClone(view)); return classification({ relation: calls === 1 ? "new" : "correction", reasoning: "diagnosis" }); });
  const history: unknown[] = [{ role: "user", content: "还是不对" }];
  const body = () => ({ model: AUTO_MODEL, client_metadata: { thread_id: "thread" }, input: structuredClone(history) });
  (await router.prepare(body())).accept();
  history.push({ type: "function_call_output", output: "一次测试结果" });
  (await router.prepare(body())).accept(); assert.equal(calls, 1);
  history.push({ role: "user", content: "还是不对" });
  (await router.prepare(body())).accept(); assert.equal(calls, 2);
  assert.deepEqual([...views[1]!.currentTask.evidence, ...views[1]!.evidence], ["一次测试结果"]);
  history.push({ role: "assistant", content: "再修一次" }, { role: "user", content: "继续" });
  const continuation = await router.prepare(body()); continuation.accept();
  assert.equal(continuation.decision!.route, "deep"); assert.equal(calls, 2);
  history.push({ role: "assistant", content: "修好了" }, { role: "user", content: "还是不对" });
  await router.prepare(body()); assert.equal(calls, 3);
});

test("full-history tool evidence is retained when the next user request supplies only its new message", async () => {
  const views: TaskView[] = [];
  const router = new Router(semanticConfig(), async view => { views.push(structuredClone(view)); return classification({ relation: views.length === 1 ? "new" : "correction", reasoning: "diagnosis" }); });
  const first = request("检查失败的测试");
  (await router.prepare(structuredClone(first))).accept();
  (await router.prepare({ ...first, input: [...first.input as unknown[], { type: "function_call_output", output: "ERROR: connection refused" }] })).accept();
  await router.prepare(request("还是不对，请参考工具报错"));
  assert.deepEqual(views.at(-1)!.currentTask.evidence, ["ERROR: connection refused"]);
});

test("shadow keeps fixed execution while tracking a separate suggested route, including continuation floors", async () => {
  let answer = classification({ reasoning: "architecture" });
  const router = new Router(semanticConfig("shadow"), async () => answer);
  const first = await router.prepare(request("设计新架构")); first.accept();
  assert.equal(first.decision!.model, "fixture-fast"); assert.equal(first.decision!.effort, "medium");
  assert.equal(first.decision!.suggestedModel, "fixture-deep"); assert.equal(first.decision!.suggestedEffort, "high");
  answer = classification({ relation: "continue" });
  const second = await router.prepare(request("补充一个小限制"));
  assert.equal(second.decision!.suggestedModel, "fixture-deep"); assert.equal(second.decision!.suggestedEffort, "high");
});

test("classification failure, low confidence and incomplete input retain the accepted route; explicit new boundaries recover", async () => {
  let answer: Classification | Error = classification({ reasoning: "architecture" }), calls = 0;
  const router = new Router(semanticConfig(), async () => { calls++; if (answer instanceof Error) throw answer; return answer; });
  (await router.prepare(request("复杂任务"))).accept();
  for (const [text, next, reason] of [
    ["新任务？", classification({}, 0.3), "low-confidence"],
    ["故障", new ClassificationError("timeout"), "timeout"],
    ["数据".repeat(12000), classification(), "input-budget"],
  ] as const) {
    answer = next;
    const prepared = await router.prepare(request(text));
    assert.equal(prepared.decision!.route, "deep"); assert.equal(prepared.decision!.classificationReason, reason);
    prepared.accept();
  }
  assert.equal(calls, 3);
  answer = classification();
  const clear = await router.prepare(request("[new] 独立任务：大写 abc"));
  assert.equal(clear.decision!.route, "fast");
});

test("a decisive high-effort signal can upgrade despite an uncertain unrelated feature", async () => {
  for (const features of [{ reasoning: "diagnosis" }, { uncertainty: "unknown_cause" }, { consequence: "sensitive" }] as const) {
    const answer = classification(features);
    answer.questionScores.scope.confidence = 0.1; answer.confidence = 0.1;
    const router = new Router(semanticConfig(), async () => answer);
    const { decision } = await router.prepare(request("需要处理的问题"));
    assert.equal(decision!.route, "deep"); assert.equal(decision!.effort, "high");
    assert.equal(decision!.classificationReason, "classified"); assert.equal(decision!.decisionConfidence, 0.95);
    assert.equal(decision!.classification!.confidence, 0.1);
    router.close();
  }
  const answer = classification({ reasoning: "diagnosis" });
  answer.questionScores.reasoning.confidence = 0.2; answer.confidence = 0.2;
  const router = new Router(semanticConfig(), async () => answer);
  assert.equal((await router.prepare(request("可能需要排查"))).decision!.classificationReason, "low-confidence");
  router.close();
});

test("a weak new-task answer cannot discard context or lower the route even when other answers are confident", async () => {
  let answer = classification({ reasoning: "architecture" });
  const views: TaskView[] = [];
  const router = new Router(semanticConfig(), async view => { views.push(structuredClone(view)); return answer; });
  (await router.prepare(request("架构目标：必须保留日志"))).accept();
  answer = classification(); answer.questionScores.relation.confidence = 0.2; answer.confidence = 0.2;
  const ambiguous = await router.prepare(request("补一个名字")); ambiguous.accept();
  assert.equal(ambiguous.decision!.route, "deep"); assert.equal(ambiguous.decision!.effort, "high");
  answer = classification({ relation: "continue" });
  (await router.prepare(request("另一个补充"))).accept();
  assert.deepEqual(views.at(-1)!.currentTask.messages, ["架构目标：必须保留日志", "补一个名字"]);
  answer = classification();
  const fresh = await router.prepare(request("新任务：排序三个数字")); fresh.accept();
  assert.equal(fresh.decision!.route, "fast");
  answer = classification({ relation: "continue" });
  await router.prepare(request("使用降序"));
  assert.deepEqual(views.at(-1)!.currentTask.messages, ["新任务：排序三个数字"]);
  router.close();
});

test("sufficient versus missing ambiguity does not block ordinary work; possible faults still gate cheap routes", async () => {
  for (const [reasoning, uncertainty, faultProbability, expectedRoute, effort, reason] of [
    ["mechanical", "sufficient", 0, "fast", "low", "classified"],
    ["mechanical", "missing", 0.01, "fast", "low", "classified"],
    ["solution", "missing", 0.01, "balanced", "medium", "classified"],
    ["mechanical", "sufficient", 0.3, "balanced", "medium", "low-confidence"],
    ["mechanical", "unknown_cause", 0.6, "balanced", "medium", "low-confidence"],
  ] as const) {
    const answer = classification({ reasoning, uncertainty });
    answer.confidence = answer.questionScores.uncertainty.confidence = 0.2;
    const other = 1 - faultProbability;
    answer.questionScores.uncertainty.probabilities = { unknown_cause: faultProbability,
      sufficient: other * (uncertainty === "missing" ? 0.45 : 0.55), missing: other * (uncertainty === "missing" ? 0.55 : 0.45) };
    const router = new Router(semanticConfig(), async () => answer);
    const { decision } = await router.prepare(request("按规则处理工作区的内容"));
    assert.equal(decision!.route, expectedRoute); assert.equal(decision!.effort, effort);
    assert.equal(decision!.classificationReason, reason);
    router.close();
  }
});

test("a confirmed new task is classified without old failures, including full history after restart", async () => {
  for (const restart of [false, true]) {
    const views: TaskView[] = [];
    const router = new Router(semanticConfig(), async view => {
      views.push(structuredClone(view));
      if (view.currentTask.messages.length || view.newMessages.length > 1 || view.newMessages[0] === "排查故障") {
        return classification({ reasoning: "diagnosis", uncertainty: "unknown_cause" });
      }
      return classification({ reasoning: "solution", consequence: "contract" });
    });
    const history: unknown[] = [{ role: "user", content: "排查故障" }];
    const body = () => ({ model: AUTO_MODEL, prompt_cache_key: "boundary", input: structuredClone(history) });
    if (!restart) (await router.prepare(body())).accept();
    history.push({ type: "function_call_output", output: "测试失败，根因未知" },
      { role: "user", content: "另一个独立任务：增加 --version" });
    const result = await router.prepare(body()); result.accept();
    assert.equal(result.decision!.route, "balanced"); assert.equal(result.decision!.effort, "medium");
    assert.equal(result.decision!.boundaryClassification!.features.uncertainty, "unknown_cause");
    assert.equal(result.decision!.classification!.features.uncertainty, "sufficient");
    assert.deepEqual(views.at(-1), { currentTask: { messages: [], evidence: [], incomplete: false },
      newMessages: ["另一个独立任务：增加 --version"], evidence: [], incomplete: false });
    assert.equal(views.length, restart ? 2 : 3);
    await router.prepare(body()); assert.equal(views.length, restart ? 2 : 3);
    router.close();
  }
});

test("failed new-task re-evaluation retains the old route and goal", async () => {
  for (const failure of [new ClassificationError("timeout"), classification({}, 0.2)]) {
    let calls = 0;
    const views: TaskView[] = [];
    const router = new Router(semanticConfig(), async view => {
      calls++; views.push(structuredClone(view));
      if (calls === 3) { if (failure instanceof Error) throw failure; return failure; }
      return classification({ relation: calls === 4 ? "continue" : "new", reasoning: "diagnosis" });
    });
    (await router.prepare(request("旧故障目标"))).accept();
    const fresh = await router.prepare(request("另外一个独立任务")); fresh.accept();
    assert.equal(fresh.decision!.route, "deep");
    assert.equal(fresh.decision!.classificationReason, failure instanceof Error ? "timeout" : "low-confidence");
    assert.ok(fresh.decision!.boundaryClassification);
    await router.prepare(request("补充约束"));
    assert.deepEqual(views.at(-1)!.currentTask.messages, ["旧故障目标", "另外一个独立任务"]);
    assert.equal(calls, 4);
    router.close();
  }
});

test("concurrent retries share classification; cancelling one waiter does not cancel the other", async () => {
  let calls = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const router = new Router(semanticConfig(), async (_view, signal) => { calls++; await ready; signal.throwIfAborted(); return classification(); });
  const abort = new AbortController();
  const a = router.prepare(request("并发任务"), abort.signal);
  const b = router.prepare(request("并发任务"));
  abort.abort(); await assert.rejects(a, /abort/i); release();
  const result = await b; result.accept();
  assert.equal(calls, 1); assert.equal(result.decision!.reason, "reused");
  await router.prepare(request("并发任务")); assert.equal(calls, 1);
});

test("all cancelled classification waiters abort the classifier and leave no cached proposal", async () => {
  let calls = 0, aborted = false;
  const router = new Router(semanticConfig(), async (_view, signal) => {
    calls++;
    if (calls === 1) {
      try { await delay(5000, undefined, { signal }); } catch (error) { aborted = true; throw error; }
    }
    return classification();
  });
  const controller = new AbortController();
  const pending = router.prepare(request(), controller.signal); controller.abort();
  await assert.rejects(pending);
  const retry = await router.prepare(request());
  assert.equal(retry.decision!.route, "fast"); assert.equal(calls, 2); assert.equal(aborted, true);
});

test("manual models and explicit rules bypass classification; environment messages are not goals", async () => {
  let calls = 0;
  const router = new Router(semanticConfig(), async view => { calls++; assert.deepEqual(view.newMessages, ["修改名字"]); return classification(); });
  const manual = { ...request(), model: "manual-model" }, original = structuredClone(manual);
  await router.prepare(manual); assert.deepEqual(manual, original);
  const explicit = await router.prepare(request("[deep] 简单任务")); explicit.accept();
  assert.equal(explicit.decision!.route, "deep"); assert.equal(calls, 0);
  const body = { ...request("修改名字", "other"), input: [{ role: "user", content: "<environment_context>工作目录</environment_context>" }, { role: "user", content: "修改名字" }] };
  await router.prepare(body); assert.equal(calls, 1);
});

test("late classification and failed proposals cannot replace a newer accepted route", async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const router = new Router(semanticConfig(), async view => {
    if (view.newMessages.includes("旧请求")) { await ready; return classification({ reasoning: "diagnosis" }); }
    return classification();
  });
  const old = router.prepare(request("旧请求"));
  (await router.prepare(request("新任务"))).accept();
  const older = await (release(), old); older.accept();
  const next = await router.prepare(request("继续"));
  assert.equal(next.decision!.route, "fast");
  await router.prepare(request("[deep] 没有被上游接受"));
  const tool = await router.prepare({ model: AUTO_MODEL, prompt_cache_key: "thread-1", input: [] });
  assert.equal(tool.decision!.route, "fast");
});
