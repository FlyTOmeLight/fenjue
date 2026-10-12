import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { startProxy, type Event } from "../src/proxy.js";
import { AUTO_MODEL, PROXY_HEADER } from "../src/config.js";
import { config, catalog, request, readJSON, serve, semanticConfig, classification, jevResponse } from "./fixtures.js";
import { createClassifier } from "../src/classification.js";

test("alias headers are normalized only for planned selection; unexpected reroutes and SSE metadata remain visible", async t => {
  let fallback = false;
  let modelHeader = "openai-model";
  const data = 'event: response.metadata\ndata: {"type":"response.metadata","metadata":{"type":"safety_buffering","reasons":["fixture"]}}\n\n';
  const upstream = await serve(async (req, res) => {
    const body = await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream", [modelHeader]: fallback ? "upstream-fallback" : body.model });
    res.end(data);
  });
  t.after(() => upstream.close());
  const c = config(upstream.url), events: Event[] = [];
  const proxy = await startProxy(c, catalog(c), e => events.push(e));
  t.after(() => proxy.close());
  const send = () => fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token }, body: JSON.stringify(request()) });
  const planned = await send();
  assert.equal(planned.headers.get("openai-model"), AUTO_MODEL);
  assert.equal(await planned.text(), data);
  fallback = true;
  const changed = await send();
  assert.equal(changed.headers.get("openai-model"), "upstream-fallback");
  assert.equal(await changed.text(), data);
  assert.ok(events.some(e => e.servedModel === "fixture-fast"));
  assert.ok(events.some(e => e.servedModel === "upstream-fallback"));
  modelHeader = "x-openai-model";
  const alternate = await send();
  assert.equal(alternate.headers.get(modelHeader), "upstream-fallback");
  assert.equal(await alternate.text(), data);
  assert.equal(events.at(-1)?.servedModel, "upstream-fallback");
});

test("changes model/effort and preserves full tool/input payload; forwards auth only upstream", async t => {
  let received: any, receivedHeaders: any;
  const upstream = await serve(async (req, res) => { received = await readJSON(req); receivedHeaders = req.headers; res.end("ok"); });
  t.after(() => upstream.close());
  const c = config(upstream.url), events: Event[] = [];
  const proxy = await startProxy(c, catalog(c), e => events.push(e));
  t.after(() => proxy.close());
  const original = request("[deep] 诊断死锁");
  const response = await fetch(proxy.url + "/responses", { method: "POST", headers: {
    [PROXY_HEADER]: proxy.token, authorization: "Bearer fixture-only", "chatgpt-account-id": "fixture-account",
  }, body: JSON.stringify(original) });
  assert.equal(await response.text(), "ok");
  assert.deepEqual(received, { ...original, model: "fixture-deep", reasoning: { effort: "high", summary: "auto" } });
  assert.equal(receivedHeaders.authorization, "Bearer fixture-only");
  assert.equal(receivedHeaders["chatgpt-account-id"], "fixture-account");
  assert.equal(receivedHeaders[PROXY_HEADER], undefined);
  assert.equal(events[0]?.route, "deep");
  assert.equal(JSON.stringify(events).includes("诊断"), false);
});

test("SSE bytes including split Chinese, emoji, CRLF and long stream stay unchanged", async t => {
  const payload = Buffer.from('event: response.created\r\ndata: {"label":"中文🙂"}\r\n\r\n' + "data: " + "汉".repeat(50000) + "\n\n");
  const upstream = await serve(async (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    const cut = payload.indexOf(Buffer.from("中")) + 1;
    res.write(payload.subarray(0, cut)); await delay(5); res.end(payload.subarray(cut));
  });
  t.after(() => upstream.close());
  const c = config(upstream.url), proxy = await startProxy(c, catalog(c));
  t.after(() => proxy.close());
  const result = await fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token }, body: JSON.stringify(request()) });
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), payload);
});

test("concurrent retries reuse route; tool continuation, short followup and replay after restart retain deep", async t => {
  const seen: any[] = [], events: Event[] = [];
  const upstream = await serve(async (req, res) => { seen.push(await readJSON(req)); res.end("ok"); });
  t.after(() => upstream.close());
  const c = config(upstream.url);
  let proxy = await startProxy(c, catalog(c), e => events.push(e));
  const send = async (body: unknown) => {
    const r = await fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token }, body: JSON.stringify(body) });
    assert.equal(r.status, 200, await r.text());
  };
  const original = request("[deep] 原始任务");
  await Promise.all([send(original), send(original)]);
  assert.equal(events.filter(e => e.event === "request" && e.reason === "reused").length, 1);
  await send({ model: AUTO_MODEL, prompt_cache_key: "thread-1", input: [{ type: "function_call_output", call_id: "a", output: "done" }] });
  const replay = { ...original, input: [...original.input as any[], { type: "function_call_output", call_id: "a", output: "done" }, { role: "user", content: "继续" }] };
  await send(replay);
  await proxy.close();
  proxy = await startProxy(c, catalog(c));
  t.after(() => proxy.close());
  await send(replay);
  assert.ok(seen.every(b => b.model === "fixture-deep" && b.reasoning.effort === "high"));
  await send(request("新任务", "thread-2"));
  assert.equal(seen.at(-1).model, "fixture-fast");
});

test("client cancellation closes upstream and proxy shutdown aborts an active stream", async t => {
  const pending: Promise<unknown>[] = [];
  const upstream = await serve(async (_req, res) => {
    pending.push(once(res, "close"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: still-running\n\n");
  });
  t.after(() => upstream.close());
  const c = config(upstream.url), proxy = await startProxy(c, catalog(c));
  const abort = new AbortController();
  const first = await fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token }, body: JSON.stringify(request()), signal: abort.signal });
  await first.body!.getReader().read();
  abort.abort();
  await Promise.race([pending[0], delay(1500).then(() => { throw new Error("cancel was not propagated"); })]);
  const second = await fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token }, body: JSON.stringify(request()) });
  const reader = second.body!.getReader();
  await reader.read();
  await proxy.close();
  await Promise.race([pending[1], delay(1500).then(() => { throw new Error("shutdown left upstream running"); })]);
  await assert.rejects(reader.read());
});

test("upstream status and interrupted streams are not rewritten as success; proxy does not replay", async t => {
  let calls = 0;
  const upstream = await serve(async (_req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(429, { "retry-after": "2" }); res.end('{"error":"quota"}'); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: partial\n\n"); await delay(10); res.destroy();
  });
  t.after(() => upstream.close());
  const c = config(upstream.url), proxy = await startProxy(c, catalog(c));
  t.after(() => proxy.close());
  const send = () => fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token }, body: JSON.stringify(request()) });
  const one = await send(); assert.equal(one.status, 429); assert.equal(one.headers.get("retry-after"), "2"); assert.equal(await one.text(), '{"error":"quota"}');
  const two = await send(); await assert.rejects(two.text());
  assert.equal(calls, 2);
});

test("manual models pass unchanged, gzip is decoded, compact path works, local catalog includes alias", async t => {
  let received: any, path = "";
  const upstream = await serve(async (req, res) => { path = req.url!; received = await readJSON(req); res.end("ok"); });
  t.after(() => upstream.close());
  const c = config(upstream.url), proxy = await startProxy(c, catalog(c));
  t.after(() => proxy.close());
  const original = { ...request(), model: "manual-choice" };
  const response = await fetch(proxy.url + "/responses/compact", { method: "POST", headers: { [PROXY_HEADER]: proxy.token, "content-encoding": "gzip" }, body: gzipSync(JSON.stringify(original)) });
  assert.equal(await response.text(), "ok"); assert.equal(path, "/responses/compact"); assert.deepEqual(received, original);
  const models = await fetch(proxy.url + "/models?client_version=test", { headers: { [PROXY_HEADER]: proxy.token } });
  assert.equal((await models.json() as any).models[0].slug, AUTO_MODEL);
});

test("rejects missing token, browser origin, invalid JSON and unknown continuation without forwarding", async t => {
  let calls = 0;
  const upstream = await serve((_req, res) => { calls++; res.end("unexpected"); });
  t.after(() => upstream.close());
  const c = config(upstream.url), proxy = await startProxy(c, catalog(c));
  t.after(() => proxy.close());
  for (const [h, body, status] of [
    [{}, JSON.stringify(request()), 403],
    [{ [PROXY_HEADER]: proxy.token, origin: "https://example.com" }, JSON.stringify(request()), 403],
    [{ [PROXY_HEADER]: proxy.token }, "{invalid", 400],
    [{ [PROXY_HEADER]: proxy.token }, JSON.stringify({ model: AUTO_MODEL, previous_response_id: "opaque", input: [] }), 409],
  ] as [Record<string,string>,string,number][]) {
    const response = await fetch(proxy.url + "/responses", { method: "POST", headers: h, body });
    assert.equal(response.status, status); await response.text();
  }
  assert.equal(calls, 0);
});

test("semantic request passes through the Jev HTTP adapter and rewrites only execution model/effort", async t => {
  const seen: any[] = [];
  const upstream = await serve(async (req, res) => { seen.push(await readJSON(req)); res.end("data: 中文结果\n\n"); });
  t.after(() => upstream.close());
  for (const mode of ["shadow", "auto"] as const) {
    const c = semanticConfig(mode, upstream.url), events: Event[] = [];
    let classifications = 0;
    const classifier = createClassifier(c.semantic!, "fixture-key", async (_url, options) => {
      classifications++;
      assert.match(String(options!.body), /排查线程死锁/);
      return Response.json(jevResponse(classification({ reasoning: "diagnosis", uncertainty: "unknown_cause" })));
    });
    const proxy = await startProxy(c, catalog(c), e => events.push(e), classifier);
    try {
      const original = request("排查线程死锁");
      for (let i = 0; i < 2; i++) {
        const response = await fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token }, body: JSON.stringify(original) });
        assert.equal(await response.text(), "data: 中文结果\n\n");
      }
      assert.equal(classifications, 1);
      assert.deepEqual(seen.at(-1), { ...original, model: mode === "auto" ? "fixture-deep" : "fixture-fast",
        reasoning: { effort: mode === "auto" ? "high" : "medium", summary: "auto" } });
      assert.equal(events[0]!.mode, mode); assert.equal(events[0]!.suggestedModel, "fixture-deep");
      assert.equal(events[0]!.classification!.features.reasoning, "diagnosis");
      assert.doesNotMatch(JSON.stringify(events), /排查线程死锁|fixture-key/);
    } finally { await proxy.close(); }
  }
});

test("closing the proxy during classification cancels Jev and never sends a model request", async t => {
  let modelCalls = 0, started!: () => void, cancelled!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const stopped = new Promise<void>(resolve => { cancelled = resolve; });
  const upstream = await serve((_req, res) => { modelCalls++; res.end("unexpected"); });
  t.after(() => upstream.close());
  const c = semanticConfig("auto", upstream.url);
  const proxy = await startProxy(c, catalog(c), undefined, async (_view, signal) => {
    started();
    try { await delay(5000, undefined, { signal }); return classification(); }
    finally { cancelled(); }
  });
  const requestPromise = fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token }, body: JSON.stringify(request()) }).catch(() => undefined);
  await entered; await proxy.close(); await stopped; await requestPromise;
  assert.equal(modelCalls, 0);
});
