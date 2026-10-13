import test from "node:test";
import assert from "node:assert/strict";
import { classifierContext } from "../src/classifier-context.js";
import { classificationPayload, ClassificationError } from "../src/classification.js";
import { semanticConfig } from "./fixtures.js";
import type { TaskView } from "../src/task-state.js";

const config = semanticConfig().semantic!;
function view(evidence: string[]): TaskView {
  return { currentTask: { messages: ["保留公开契约和审计约束"], evidence, incomplete: false },
    newMessages: ["按已经确定的方案实施"], evidence: [], incomplete: false };
}

test("context selection preserves complete small inputs and never mutates originals", () => {
  const original = view(["根因已经定位，按既定方案修改"]);
  const selected = classifierContext(original, config);
  assert.deepEqual(selected, original);
  selected.currentTask.evidence.push("other");
  assert.equal(original.currentTask.evidence.length, 1);
});

test("latest-message projection drops oversized old evidence before applying the input budget", () => {
  const original = view(["旧工具证据".repeat(100000)]), saved = structuredClone(original);
  original.currentTask.incomplete = true;
  const selected = classifierContext(original, config, false, "latest-message");
  assert.deepEqual(selected.currentTask, { messages: [], evidence: [], incomplete: false });
  assert.deepEqual(selected.newMessages, original.newMessages);
  assert.equal(original.currentTask.evidence[0], saved.currentTask.evidence[0]);
  assert.throws(() => classifierContext({ ...original, incomplete: true }, config, false, "latest-message"),
    e => e instanceof ClassificationError && e.code === "incomplete-context");
});

test("JSON byte budgets include escaping and multibyte evidence while preserving source conclusions", () => {
  for (const content of ["中文😀\\\"\n".repeat(15000), "\\\"".repeat(50000)]) {
    const conclusion = "根因是目录过滤，已经确认使用既定接口。";
    const original = view([content + conclusion]), saved = structuredClone(original);
    const selected = classifierContext(original, config, true);
    assert.ok(Buffer.byteLength(classificationPayload(selected, config, true)) <= config.maxInputBytes);
    assert.ok(selected.currentTask.evidence[0]!.endsWith(conclusion));
    assert.match(selected.currentTask.evidence[0]!, /Fenjue: omitted/);
    assert.doesNotMatch(selected.currentTask.evidence[0]!, /\uFFFD/);
    assert.equal(selected.currentTask.incomplete, true);
    assert.deepEqual(original, saved);
  }
});

test("overflow removes old tool bulk before prior conclusions and keeps newest evidence", () => {
  const oldConclusion = "已经确定接口协议和审计要求";
  const tools = Array.from({ length: 15 }, (_, i) => JSON.stringify({ command: `test ${i}`, exitCode: 0, output: "旧工具日志".repeat(300) }));
  const selected = classifierContext(view([oldConclusion, ...tools, "当前故障已解决"]), config);
  assert.ok(selected.currentTask.evidence.includes(oldConclusion));
  assert.equal(selected.currentTask.evidence.at(-1), "当前故障已解决");
  assert.ok(Buffer.byteLength(classificationPayload(selected, config)) <= config.maxInputBytes);
});

test("oversized current input and missing non-text input cannot be disguised by context excerpts", () => {
  const oversized = view(["已知结论"]); oversized.newMessages = ["任务正文".repeat(10000)];
  assert.throws(() => classifierContext(oversized, config), e => e instanceof ClassificationError && e.code === "input-budget");
  assert.throws(() => classifierContext({ ...view([]), incomplete: true }, config), e => e instanceof ClassificationError && e.code === "incomplete-context");
});
