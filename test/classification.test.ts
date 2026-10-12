import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createClassifier, parseClassification, classificationPayload } from "../src/classification.js";
import { taskView, readTaskInput } from "../src/task-state.js";
import { classification, jevResponse, request, semanticConfig, kevConfig } from "./fixtures.js";
import { parseConfig } from "../src/config.js";

test("constraint candidates request and validate the sixth answer without changing the baseline contract", async () => {
  const s = semanticConfig().semantic!, view = taskView(readTaskInput(request("比较内存、延迟和一致性的取舍")));
  const response = { ...jevResponse(), answers: { ...jevResponse().answers, constraints: {
    type: "choice", choice: "coupled", confidence: 0.9, probabilities: { independent: 0.1, coupled: 0.9 },
  } } };
  const classify = createClassifier(s, "fixture", async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    assert.equal(Object.keys(body.questions).length, 6);
    assert.match(body.questions.constraints.instructions, /系统或文件数量/);
    return Response.json(response);
  }, true);
  assert.equal((await classify(view, new AbortController().signal)).constraints!.choice, "coupled");
  assert.equal(parseClassification(response, s.model).constraints, undefined);
  for (const constraints of [undefined, { ...response.answers.constraints, choice: "invented" },
    { ...response.answers.constraints, probabilities: { independent: 0.9, coupled: 0.1 } },
    { ...response.answers.constraints, probabilities: { independent: 0.4, coupled: 0.9 } }]) {
    assert.throws(() => parseClassification({ ...response, answers: { ...response.answers, constraints } }, s.model, true), /invalid-response/);
  }
  const baseBytes = Buffer.byteLength(classificationPayload(view, s));
  assert.throws(() => classificationPayload(view, { ...s, maxInputBytes: baseBytes }, true), /input-budget/);
});

test("Jev uses the documented atomic Choice contract, a pinned version and only task context", async () => {
  const config = semanticConfig().semantic!, view = taskView(readTaskInput(request("把名字改成中文")));
  let calls = 0;
  const classify = createClassifier(config, "fixture-secret", async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init!.redirect, "error");
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer fixture-secret");
    const payload = JSON.parse(String(init!.body));
    assert.equal(payload.model, "jev-1.13.0");
    assert.equal(Object.keys(payload.questions).length, 5);
    assert.deepEqual(payload.state.newMessages, ["把名字改成中文"]);
    assert.doesNotMatch(String(init!.body), /fixture-secret|prompt_cache_key|parameters/);
    return Response.json(jevResponse());
  });
  assert.deepEqual(await classify(view, new AbortController().signal), classification());
  assert.equal(calls, 1);
});

test("invalid answers, drifting model versions and contradictory probability distributions are rejected", () => {
  const good = jevResponse();
  for (const value of [
    { ...good, model: "jev-new-version" },
    { ...good, answers: {} },
    { ...good, usage: { input_tokens: -1 } },
    ...[
      { choice: "invented" }, { confidence: NaN }, { probabilities: { new: 0.1, continue: 0.9, correction: 0, uncertain: 0 } },
      { probabilities: { new: 0.7, continue: 0.7, correction: 0, uncertain: 0 } }, { probabilities: { new: 1 } },
    ].map(patch => ({ ...good, answers: { ...good.answers, relation: { ...good.answers.relation, ...patch } } })),
  ]) assert.throws(() => parseClassification(value, "jev-1.13.0"), /invalid-response/);
});

test("per-question scores survive parsing and the weakest question gates the result", () => {
  const body = jevResponse();
  body.answers.uncertainty!.confidence = 0.1;
  body.answers.uncertainty!.probabilities = { sufficient: 0.4, missing: 0.35, unknown_cause: 0.25 };
  const result = parseClassification(body, body.model);
  assert.equal(result.confidence, 0.1);
  assert.deepEqual(result.questionScores.uncertainty, { confidence: 0.1, probabilities: { sufficient: 0.4, missing: 0.35, unknown_cause: 0.25 } });
  assert.equal(result.questionScores.relation.confidence, 0.95);
  body.answers.uncertainty!.probabilities.sufficient = 0;
  assert.equal(result.questionScores.uncertainty.probabilities.sufficient, 0.4);
});

test("Jev failures are explicit and bounded; timeout/cancellation do not trigger retries", async () => {
  const s = { ...semanticConfig().semantic!, timeoutMs: 10 }, view = taskView(readTaskInput(request()));
  const signal = new AbortController().signal;
  await assert.rejects(createClassifier(s, "")(view, signal), /missing-key/);
  let calls = 0;
  const timeout = createClassifier(s, "test", async (_url, init) => {
    calls++;
    await delay(1000, undefined, { signal: init!.signal! });
    return Response.json(jevResponse());
  });
  await assert.rejects(timeout(view, signal), /timeout/);
  assert.equal(calls, 1);
  const abort = new AbortController();
  const pending = timeout(view, abort.signal); abort.abort(new Error("user cancelled"));
  await assert.rejects(pending, /user cancelled/);
  const unavailable = createClassifier(s, "test", async () => Response.json({ error: "secret server detail" }, { status: 429 }));
  await assert.rejects(unavailable(view, signal), /^Error: http-429$/);
});

test("the complete UTF-8 request is budgeted; images and oversized goals are never silently truncated", () => {
  const s = semanticConfig().semantic!;
  const large = taskView(readTaskInput(request("约束".repeat(10000))));
  assert.throws(() => classificationPayload(large, s), /input-budget/);
  assert.equal(large.newMessages[0]!.length, 20000);
  const image = taskView(readTaskInput({ input: [{ role: "user", content: [{ type: "input_image", image_url: "data:test" }] }] }));
  assert.throws(() => classificationPayload(image, s), /incomplete-context/);
});

test("partial history reaches the classifier with its missing-context marker intact", async () => {
  const s = semanticConfig().semantic!, view = {
    currentTask: { messages: ["可用的历史约束"], evidence: [], incomplete: true },
    newMessages: ["比较订单、支付、库存三个独立服务的一致性架构"], evidence: [], incomplete: false,
  };
  const expected = classification({ scope: "cross_system", reasoning: "architecture" });
  const classify = createClassifier(s, "fixture", async (_url, init) => {
    const payload = JSON.parse(String(init!.body));
    assert.deepEqual(payload.state, view);
    assert.match(payload.questions.relation.instructions, /历史有缺失/);
    return Response.json(jevResponse(expected));
  });
  assert.deepEqual(await classify(view, new AbortController().signal), expected);
});

test("Kev ignores ambient TypeSafe credentials, sends the configured model and accepts native response metadata", async () => {
  const s = kevConfig().semantic!, view = taskView(readTaskInput(request("排查死锁")));
  const oldKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "official-key-must-stay-private";
  try {
    const expected = { ...classification({ reasoning: "diagnosis" }), model: "kev-latest" };
    const classify = createClassifier(s, undefined, async (url, init) => {
      assert.equal(url, s.endpoint);
      assert.equal(new Headers(init!.headers).has("authorization"), false);
      assert.equal(init!.redirect, "error");
      const payload = JSON.parse(String(init!.body));
      assert.equal(payload.model, "kev-latest");
      assert.equal(Object.keys(payload.questions).length, 5);
      assert.doesNotMatch(String(init!.body), /official-key/);
      const body = jevResponse(expected);
      return Response.json({ ...body, latency_ms: 495, truncated: false, usage: { ...body.usage, state_tokens: 60, state_tokens_used: 60 } });
    });
    assert.deepEqual(await classify(view, new AbortController().signal), expected);
  } finally {
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
  }
});

test("Kev authentication is explicit; a missing configured key prevents a request", async () => {
  const s = { ...kevConfig().semantic!, apiKeyEnv: "KEV_API_KEY" }, view = taskView(readTaskInput(request()));
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(url, s.endpoint);
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer local-fixture-key");
    return Response.json(jevResponse({ ...classification(), model: "kev-latest" }));
  };
  await assert.rejects(createClassifier(s, "", fetcher)(view, new AbortController().signal), /missing-key/);
  assert.equal(calls, 0);
  await createClassifier(s, "local-fixture-key", fetcher)(view, new AbortController().signal);
  assert.equal(calls, 1);
});

test("Kev truncation or inconsistent truncation metadata cannot silently influence routing", () => {
  const response = jevResponse({ ...classification(), model: "kev-latest" });
  for (const patch of [
    { truncated: true },
    { truncated: false, usage: { ...response.usage, state_tokens: 70000, state_tokens_used: 65536 } },
    { usage: { ...response.usage, state_tokens: 70000, state_tokens_used: 65536 } },
  ]) assert.throws(() => parseClassification({ ...response, ...patch }, "kev-latest"), /truncated-context/);
  for (const patch of [{ truncated: "false" }, { usage: { ...response.usage, state_tokens: 30 } },
    { usage: { ...response.usage, state_tokens: 30, state_tokens_used: 40 } }]) {
    assert.throws(() => parseClassification({ ...response, ...patch }, "kev-latest"), /invalid-response/);
  }
});

test("Kev failure stays on the selected endpoint without cloud fallback or retries", async () => {
  const s = kevConfig().semantic!, view = taskView(readTaskInput(request()));
  const urls: unknown[] = [];
  const classify = createClassifier(s, undefined, async url => {
    urls.push(url); throw new TypeError("connection refused");
  });
  await assert.rejects(classify(view, new AbortController().signal), /unavailable/);
  assert.deepEqual(urls, [s.endpoint]);
});

test("Vercel shares the SystemOne contract and preserves its alias without inventing a Jev version", async () => {
  const c = semanticConfig();
  const s = parseConfig({ ...c, semantic: { ...c.semantic, provider: "vercel", endpoint: undefined, apiKeyEnv: undefined, model: "typesafe-ai/jev" } }).semantic!;
  const result = { ...classification(), model: "typesafe-ai/jev" };
  const classify = createClassifier(s, "gateway-fixture-key", async (url, init) => {
    assert.equal(url, "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer gateway-fixture-key");
    const payload = JSON.parse(String(init!.body));
    assert.equal(payload.model, "typesafe-ai/jev"); assert.equal(payload.providerOptions, undefined);
    return Response.json({ ...jevResponse(result), provider_metadata: { gateway: { routing: { finalProvider: "typesafe-ai" } } } });
  });
  assert.deepEqual(await classify(taskView(readTaskInput(request())), new AbortController().signal), result);
});
