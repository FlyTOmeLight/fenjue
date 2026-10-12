import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/routing.js";
import { AUTO_MODEL } from "../src/config.js";
import { config, request } from "./fixtures.js";

test("partial followups inherit accepted route; late successful retry cannot overwrite a newer turn", async () => {
  const router = new Router(config("http://127.0.0.1:1"));
  const first = await router.prepare(request("[deep] 任务")); first.accept();
  const follow = request("继续"); (await router.prepare(follow)).accept();
  assert.equal(follow.model, "fixture-deep");
  const next = request("新的简单任务"); (await router.prepare(next)).accept();
  first.accept();
  const tool = { model: AUTO_MODEL, prompt_cache_key: "thread-1", input: [{ type: "function_call_output", output: "ok" }] };
  await router.prepare(tool);
  assert.equal(tool.model, "fixture-fast");
});

test("retries reuse original route even if a newer turn has changed the current model", async () => {
  const router = new Router(config("http://127.0.0.1:1"));
  (await router.prepare(request("[deep] 任务"))).accept();
  const follow = request("继续"); (await router.prepare(follow)).accept();
  (await router.prepare(request("新的任务"))).accept();
  const retry = request("继续");
  await router.prepare(retry);
  assert.equal(retry.model, "fixture-deep");
  (await router.prepare(request("[deep] 第三个任务"))).accept();
  const tail = { model: AUTO_MODEL, prompt_cache_key: "thread-1", input: [] };
  await router.prepare(tail); assert.equal(tail.model, "fixture-deep");
});

test("failed proposal does not become accepted continuation state; conflicting effort updates reject", async () => {
  const router = new Router(config("http://127.0.0.1:1"));
  (await router.prepare(request("初始任务"))).accept();
  await router.prepare(request("[deep] 尚未被上游接受"));
  const tail = { model: AUTO_MODEL, prompt_cache_key: "thread-1", input: [] };
  await router.prepare(tail); assert.equal(tail.model, "fixture-fast");
  await assert.rejects(() => router.prepare({ ...request(), input: [{ type: "configuration_update", reasoning: { effort: "low" } }] }), /请求级 effort/);
});
