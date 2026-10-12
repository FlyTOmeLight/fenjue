import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startProxy, type Event } from "../src/proxy.js";
import { PROXY_HEADER } from "../src/config.js";
import { evaluationCases } from "../src/evaluation-cases.js";
import { catalog, classification, jevResponse, kevConfig, request, readJSON, serve } from "./fixtures.js";

test("Kev HTTP classification selects the execution model; truncated answers retain the accepted route", async t => {
  let truncated = false, classificationCalls = 0;
  const local = await serve(async (req, res) => {
    assert.equal(req.url, "/v1/systemone");
    assert.equal(req.headers.authorization, undefined);
    const body = await readJSON(req); classificationCalls++;
    assert.equal(body.model, "kev-latest");
    assert.equal(Object.keys(body.questions).length, 5);
    assert.doesNotMatch(JSON.stringify(body), /gpt-credential|fixture-account/);
    const result = { ...classification(truncated ? {} : { reasoning: "diagnosis", uncertainty: "unknown_cause" }), model: body.model };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...jevResponse(result), truncated, latency_ms: 25 }));
  });
  t.after(() => local.close());
  const seen: Record<string, any>[] = [];
  const upstream = await serve(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer gpt-credential");
    seen.push(await readJSON(req)); res.end("data: 执行结果\n\n");
  });
  t.after(() => upstream.close());
  const c = kevConfig(local.url + "/v1/systemone", "auto", upstream.url), events: Event[] = [];
  const proxy = await startProxy(c, catalog(c), event => events.push(event));
  t.after(() => proxy.close());
  async function send(body: unknown) {
    const response = await fetch(proxy.url + "/responses", { method: "POST",
      headers: { [PROXY_HEADER]: proxy.token, authorization: "Bearer gpt-credential", "chatgpt-account-id": "fixture-account" }, body: JSON.stringify(body) });
    assert.equal(await response.text(), "data: 执行结果\n\n");
  }
  const original = request("死锁原因未知，请排查");
  await send(original);
  assert.deepEqual(seen[0], { ...original, model: "fixture-deep", reasoning: { effort: "high", summary: "auto" } });
  assert.equal(events[0]!.classification!.model, "kev-latest");
  await send(original); assert.equal(classificationCalls, 1);
  truncated = true;
  await send(request("另一个独立的简单任务"));
  assert.equal(seen.at(-1)!.model, "fixture-deep");
  assert.equal(events.filter(e => e.event === "request").at(-1)!.classificationReason, "truncated-context");
  assert.equal(classificationCalls, 2);
  assert.doesNotMatch(JSON.stringify(events), /死锁原因|gpt-credential|fixture-account/);
});

test("classifier evaluation CLI reaches a local Kev-compatible server with optional authentication and no GPT requests", async t => {
  const cases = await evaluationCases();
  const turns = new Map(cases.flatMap(c => c.turns.map(turn => [turn.text, turn] as const)));
  let expectedAuth: string | undefined, calls = 0;
  const local = await serve(async (req, res) => {
    assert.equal(req.url, "/kev/v1/systemone");
    assert.equal(req.headers.authorization, expectedAuth);
    const body = await readJSON(req); calls++;
    assert.equal(body.model, "kev-custom-run");
    assert.equal(body.state.expected, undefined);
    assert.equal(body.state.features, undefined);
    const text = body.state.newMessages.at(-1);
    const turn = turns.get(text); assert.ok(turn, text);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(jevResponse({ ...classification(turn.features), model: body.model })));
  });
  t.after(() => local.close());
  const temp = await mkdtemp(join(tmpdir(), "fenjue-kev-eval-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const auth of [false, true]) {
    expectedAuth = auth ? "Bearer local-only-key" : undefined;
    const c = kevConfig(local.url + "/kev/v1/systemone");
    c.semantic!.model = "kev-custom-run";
    if (auth) c.semantic!.apiKeyEnv = "FENJUE_KEV_TEST_KEY";
    const path = join(temp, "config.json");
    await writeFile(path, JSON.stringify(c));
    const { stdout } = await promisify(execFile)(process.execPath, [resolve("dist/scripts/evaluate-classifier.js"), "--config", path, "--live", "--max-calls", "24"], {
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "must-not-be-forwarded", ...(auth ? { FENJUE_KEV_TEST_KEY: "local-only-key" } : {}) }, timeout: 15000,
    });
    const report = JSON.parse(stdout);
    assert.equal(report.provider, "kev"); assert.equal(report.endpoint, c.semantic!.endpoint);
    assert.equal(report.classifier, "kev-custom-run");
    assert.equal(report.liveClassifierCalls, 17); assert.equal(report.policyMatched, 17);
    assert.equal(report.realGPTCalls, 0);
    assert.equal(report.acceptedClassifications, 16);
    assert.equal(report.acceptedPolicyMatched, 16);
    assert.equal(report.underpoweredDeepTurns, 0);
    assert.equal(report.underpoweredTurns, 0);
    assert.equal(report.rows.reduce((n: number, row: { classificationPasses: number }) => n + row.classificationPasses, 0), 17);
    assert.equal(report.rows.filter((row: { boundaryClassification?: unknown }) => row.boundaryClassification).length, 1);
    assert.equal(report.rows[0].questionScores.relation.confidence, 0.95);
    assert.doesNotMatch(stdout, /local-only-key|must-not-be-forwarded/);
  }
  assert.equal(calls, 34); assert.deepEqual(local.errors, []);
  const casesPath = join(temp, "custom-cases.json");
  await writeFile(casesPath, JSON.stringify(cases.slice(0, 2).map(c => ({ ...c, turns: c.turns.map(turn => ({
    ...turn, features: Object.fromEntries(Object.entries(turn.features).reverse()),
  })) }))));
  expectedAuth = undefined;
  const configPath = join(temp, "custom-config.json"), c = kevConfig(local.url + "/kev/v1/systemone");
  c.semantic!.model = "kev-custom-run";
  await writeFile(configPath, JSON.stringify(c));
  const { stdout } = await promisify(execFile)(process.execPath, [resolve("dist/scripts/evaluate-classifier.js"), "--config", configPath,
    "--cases", casesPath, "--min-confidence", "0.9", "--live", "--max-calls", "2"], { timeout: 15000 });
  const custom = JSON.parse(stdout);
  assert.equal(custom.dataset, casesPath); assert.equal(custom.minConfidence, 0.9);
  assert.equal(custom.turns, 2); assert.equal(custom.liveClassifierCalls, 2);
  assert.equal(custom.policyMatched, 2); assert.equal(calls, 36);
  await writeFile(casesPath, "[]");
  await assert.rejects(promisify(execFile)(process.execPath, [resolve("dist/scripts/evaluate-classifier.js"), "--config", configPath,
    "--cases", casesPath, "--live", "--max-calls", "2"]), /评测集必须包含至少一个场景/);
  assert.equal(calls, 36);
});
