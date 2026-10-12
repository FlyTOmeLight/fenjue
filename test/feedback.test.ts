import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addFeedback, observedTasks, iterationReport, reportMarkdown } from "../src/feedback.js";
import { fingerprint } from "../src/task-state.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "fenjue-feedback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "daily"));
  const event = (type: string, details = {}) => ({ time: "2026-10-02T00:00:00.000Z", type, threadId: "thread", taskId: "task", turnId: "turn", ...details });
  await writeFile(join(root, "native-1-1.jsonl"), [
    event("accepted", { route: { model: "sol", effort: "medium" }, reason: "low-confidence", policy: "v1" }),
    event("usage", { tokenUsage: { last: { totalTokens: 10 }, total: { totalTokens: 1000 } } }),
    event("usage", { tokenUsage: { last: { totalTokens: 20 }, total: { totalTokens: 1020 } } }),
    event("completed", { time: "2026-10-02T00:00:01.000Z", status: "completed" }),
  ].map(e => JSON.stringify(e)).join("\n") + "\n" + '{"unfinished":');
  await writeFile(join(root, "native-2-2.jsonl"), [event("usage", { tokenUsage: { last: { totalTokens: 20 }, total: { totalTokens: 1020 } } })].map(e => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(root, "daily", "capture-1-1.jsonl"), JSON.stringify({ version: 1, time: "2026-10-02T00:00:00.000Z",
    taskId: "task", turnId: "turn", thread: fingerprint("thread"), identity: "provided", request: 1, change: "append",
    items: [{ kind: "user", text: "修复并发顺序" }] }) + "\n");
  return root;
}

test("reports merge resumed tasks, deduplicate usage and never call completed accepted", async t => {
  const root = await fixture(t), tasks = await observedTasks(root);
  assert.equal(tasks.length, 1); assert.equal(tasks[0]!.observedTokens, 30);
  assert.equal(tasks[0]!.preview, "修复并发顺序");
  const report = iterationReport(tasks, 7, new Date("2026-10-04T00:00:00Z"));
  assert.deepEqual(report.summary.outcomes, { unknown: 1 });
  assert.equal(report.summary.recordedExecutionMs, 1000);
  assert.deepEqual(report.candidates[0]!.reasons, ["分类低置信度", "缺少任务反馈"]);
  assert.match(reportMarkdown(report), /修复并发顺序/);
});

test("feedback validates identity, preserves history and redacts credentials", async t => {
  const root = await fixture(t), input = { taskId: "task", outcome: "rework" as const, cause: "implementation" as const,
    reviewer: "light", reason: "遗漏顺序约束", evidence: "password=veryprivate" };
  await assert.rejects(() => addFeedback(root, { ...input, taskId: "missing" }), /未找到/);
  await assert.rejects(() => addFeedback(root, { ...input, turnId: "other" }), /不属于/);
  await assert.rejects(() => addFeedback(root, { ...input, reviewer: "" }), /reviewer/);
  const first = await addFeedback(root, input, new Date("2026-10-02T01:00:00Z"));
  const path = join(root, "feedback", `feedback-${first.id}.json`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path, "utf8"), /veryprivate/);
  await addFeedback(root, { ...input, outcome: "accepted", reason: "验收已通过" }, new Date("2026-10-03T01:00:00Z"));
  const tasks = await observedTasks(root);
  assert.equal(tasks[0]!.feedback.length, 2);
  assert.deepEqual(iterationReport(tasks, 7, new Date("2026-10-04T00:00:00Z")).summary.outcomes, { accepted: 1 });
});

test("turn feedback and future feedback cannot certify a whole task", async t => {
  const root = await fixture(t), base = { taskId: "task", outcome: "accepted" as const, cause: "unknown" as const, reviewer: "light", reason: "这一轮完成" };
  await addFeedback(root, { ...base, turnId: "turn" }, new Date("2026-10-02T01:00:00Z"));
  await addFeedback(root, base, new Date("2026-10-05T00:00:00Z"));
  const report = iterationReport(await observedTasks(root), 7, new Date("2026-10-04T00:00:00Z"));
  assert.deepEqual(report.summary.outcomes, { unknown: 1 });
  assert.equal(report.candidates[0]!.turnFeedback.length, 1);
});

test("report window keeps usage unknown when only part of a task is included", async t => {
  const root = await fixture(t), tasks = await observedTasks(root);
  tasks[0]!.turns.push({ turnId: "old", time: "2026-09-01T00:00:00Z", route: { model: "sol", effort: "low" }, reason: "classified" });
  assert.equal(iterationReport(tasks, 7, new Date("2026-10-04T00:00:00Z")).summary.observedTokens, null);
});

test("a new user turn invalidates acceptance of the previous result", async t => {
  const root = await fixture(t);
  await addFeedback(root, { taskId: "task", outcome: "accepted", cause: "unknown", reviewer: "light", reason: "上一版通过" }, new Date("2026-10-02T01:00:00Z"));
  const tasks = await observedTasks(root);
  tasks[0]!.turns.push({ turnId: "new", time: "2026-10-03T00:00:00Z", route: { model: "sol", effort: "medium" }, reason: "classified" });
  assert.deepEqual(iterationReport(tasks, 7, new Date("2026-10-04T00:00:00Z")).summary.outcomes, { unknown: 1 });
});
