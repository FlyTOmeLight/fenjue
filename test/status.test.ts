import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeRouteStatus, RouteStatus, createTitleDisplay, latestLog, showStatus } from "../src/status.js";

test("native status separates failure cause from classification and shows capacity retry outcomes", () => {
  const status = new NativeRouteStatus();
  const common = { threadId: "thread", mode: "auto" as const, route: { model: "sol", effort: "high" } };
  const error = { message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded" };
  status.update({ ...common, type: "accepted", reason: "classified" });
  status.update({ ...common, type: "completed", status: "failed", error });
  assert.match(status.line(), /模型容量不足/); assert.doesNotMatch(status.line(), /classified/);
  status.update({ ...common, type: "retrying", fromModel: "sol", toModel: "astra" });
  assert.match(status.line(), /sol.*容量不足.*astra.*1\/1/);
  status.update({ ...common, route: { model: "astra", effort: "high" }, type: "accepted", reason: "capacity-retry" });
  status.update({ ...common, route: { model: "astra", effort: "high" }, type: "completed", status: "failed",
    error: { message: "Backup denied", codexErrorInfo: "other" }, previousError: error });
  assert.match(status.line(), /首次.*模型容量不足.*重试.*Backup denied/);
  status.update({ ...common, type: "accepted", reason: "classified" });
  status.update({ ...common, type: "completed", status: "completed" });
  assert.match(status.line(), /轮次完成.*classified/); assert.doesNotMatch(status.line(), /Backup denied|首次/);
});

test("status follows the newest request and distinguishes selected and reported models", () => {
  const status = new RouteStatus();
  assert.match(status.line(), /等待模型请求/);
  status.update({ event: "request", request: 1, model: "fast", effort: "low", route: "balanced", reason: "default" });
  assert.match(status.line(), /请求 fast · low/);
  assert.match(status.line(), /上游报告 未提供/);
  status.update({ event: "request", request: 2, model: "deep", effort: "high", route: "deep", reason: "prefix" });
  assert.equal(status.update({ event: "completed", request: 1, status: 200, servedModel: "fast" }), false);
  assert.match(status.line(), /请求 deep · high/);
  status.update({ event: "completed", request: 2, status: 503, servedModel: "fallback", elapsedMs: 2500 });
  assert.match(status.line(), /HTTP 503/);
  assert.match(status.line(), /上游报告 fallback/);
  assert.match(status.line(), /路线 deep（prefix）/);
  status.update({ event: "request", request: 3, model: "manual" });
  assert.match(status.line(), /路线 手动/);
  assert.match(status.line(), /上游报告 未提供/);
  status.update({ event: "failed", request: 3, reason: "cancelled" });
  assert.match(status.line(), /已取消/);
});

test("status reads native completion without inventing HTTP success or quality labels", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-native-status-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, "native-200-1.jsonl");
  await writeFile(join(temp, "route-100-1.jsonl"), "");
  await writeFile(path, [
    { type: "accepted", threadId: "thread", turnId: "turn", mode: "auto", route: { model: "astra", effort: "high" }, reason: "classified" },
    { type: "rerouted", threadId: "thread", turnId: "turn", mode: "auto", toModel: "reported" },
    { type: "completed", threadId: "thread", turnId: "turn", mode: "auto", route: { model: "astra", effort: "high" }, status: "completed", quality: "unknown" },
  ].map(e => JSON.stringify(e) + "\n").join(""));
  assert.equal(await latestLog(temp), path);
  let output = ""; await showStatus(path, { write: text => { output += text; } });
  assert.match(output, /astra · high.*轮次完成.*classified.*服务端改为 reported/);
  assert.doesNotMatch(output, /HTTP|质量合格/);
});

test("title uses bounded sanitized OSC, ignores older responses and clears on exit", () => {
  const writes: string[] = [];
  const title = createTitleDisplay(text => { writes.push(text); });
  title.onEvent({ event: "request", request: 2, model: "gpt\x07\x1b\u009d\u202e测试", effort: "high" });
  assert.match(writes.at(-1)!, /^\x1b\]0;焚诀 \| 请求 gpt测试 · high.*\x07$/);
  const length = writes.length;
  title.onEvent({ event: "completed", request: 1, status: 200 });
  assert.equal(writes.length, length);
  title.onEvent({ event: "request", request: 3, model: "🙂".repeat(400) });
  assert.ok(Array.from(writes.at(-1)!.slice(4, -1)).length <= 240);
  title.close(); title.close();
  title.onEvent({ event: "request", request: 4, model: "late" });
  assert.equal(writes.length, length + 2);
  assert.equal(writes.at(-1), "\x1b]0;\x07");
});

test("status exposes shadow suggestion separately from execution and explains automatic holds", () => {
  const status = new RouteStatus();
  status.update({ event: "request", request: 1, model: "actual", effort: "medium", mode: "shadow",
    suggestedModel: "candidate", suggestedEffort: "high", classificationReason: "classified" });
  for (const compact of [true, false]) {
    assert.match(status.line(compact), /请求 actual · medium/);
    assert.match(status.line(compact), /观察建议 candidate · high \(classified\)/);
  }
  status.update({ event: "request", request: 2, model: "actual", effort: "medium", mode: "auto", classificationReason: "missing-key" });
  assert.match(status.line(true), /自动 \(missing-key\)/);
  assert.doesNotMatch(status.line(), /candidate/);
});

test("status finds the latest launch and snapshots only its most recent request", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-status-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await assert.rejects(latestLog(temp), /没有路由记录/);
  await writeFile(join(temp, "route-9-1.jsonl"), "");
  const path = join(temp, "route-10-2.jsonl");
  const events = [
    { event: "request", request: 1, model: "old" },
    { event: "request", request: 2, model: "new", effort: "high" },
    { event: "completed", request: 2, status: 200, time: "2026-10-01T13:00:00Z" },
    { event: "completed", request: 1, status: 200, servedModel: "old" },
  ];
  await writeFile(path, events.map(e => JSON.stringify(e) + "\n").join(""));
  await writeFile(join(temp, "unrelated.jsonl"), "not a log");
  assert.equal(await latestLog(temp), path);
  let output = "";
  await showStatus(path, { write: text => { output += text; } });
  assert.match(output, /2026-10-01T13:00:00Z 焚诀 \| 请求 new · high/);
  assert.match(output, /HTTP 200/);
  assert.doesNotMatch(output, /请求 old|上游报告 old|\x1b/);
});

test("watch reads appended partial UTF-8/JSON without stale models and stops on cancellation", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-watch-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, "route-1-1.jsonl");
  await writeFile(path, "");
  const controller = new AbortController();
  let output = "";
  const watching = showStatus(path, { watch: true, signal: controller.signal, write: text => { output += text; } });
  async function until(pattern: RegExp) {
    const deadline = Date.now() + 3000;
    while (!pattern.test(output)) {
      if (Date.now() >= deadline) assert.fail(`watch timeout: ${output}`);
      await delay(10);
    }
  }
  try {
    await until(/等待模型请求/);
    const line = Buffer.from(JSON.stringify({ event: "request", request: 1, model: "中文🙂", effort: "high" }) + "\n");
    const cut = line.indexOf(Buffer.from("中")) + 1;
    await appendFile(path, line.subarray(0, cut));
    await delay(300); // Allow a poll to consume an incomplete UTF-8 sequence.
    assert.doesNotMatch(output, /请求 中文/);
    await appendFile(path, line.subarray(cut));
    await until(/请求 中文🙂 · high/);
    await appendFile(path, JSON.stringify({ event: "completed", request: 1, status: 200, servedModel: "reported" }) + "\n");
    await until(/上游报告 reported/);
    assert.doesNotMatch(output, /�|\x1b/);
  } finally { controller.abort(); await watching; }
});
