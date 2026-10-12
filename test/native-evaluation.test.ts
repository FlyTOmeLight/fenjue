import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluateNativeCase, parseNativeEvaluationCases, declaredNativeClassification } from "../src/native-evaluation.js";
import { parseConfig } from "../src/config.js";
import { serve, jevResponse } from "./fixtures.js";

async function cases(name: string) {
  return parseNativeEvaluationCases(JSON.parse(await readFile(`evals/native-routing/${name}.json`, "utf8")));
}
async function config(candidate = false) {
  const c = JSON.parse(await readFile("examples/native-balanced.json", "utf8"));
  if (candidate) c.native.expertPolicy = "constraints";
  return parseConfig(c);
}

test("native calibration and independent holdout exercise the production planner against declared routes", async () => {
  const calibration = await cases("calibration"), holdout = await cases("holdout");
  assert.ok(holdout.every(c => !calibration.some(other => other.group === c.group)));
  assert.throws(() => parseNativeEvaluationCases([{ ...calibration[0], split: "holdout", id: "leak" }, ...calibration]), /group/);
  for (const candidate of [false, true]) for (const scenario of [...calibration, ...holdout]) {
    const rows = await evaluateNativeCase(await config(candidate), scenario, undefined, new AbortController().signal);
    assert.equal(rows.length, scenario.turns.length);
    for (const row of rows) {
      assert.equal(row.policyMatch, true, `${candidate ? "constraints" : "baseline"} ${row.case} ${row.turn}: ${JSON.stringify(row.route)}`);
      assert.equal(row.reasonMatch, true, `${row.case} ${row.turn}: ${row.reason}`);
    }
  }
});

test("native evaluator passes task text and prior evidence, never expected routes or labels", async () => {
  const scenario = (await cases("holdout"))[0]!, c = await config(true);
  let index = 0;
  const rows = await evaluateNativeCase(c, scenario, async view => {
    assert.deepEqual(Object.keys(view).sort(), ["currentTask", "evidence", "incomplete", "newMessages"]);
    assert.doesNotMatch(JSON.stringify(view), /allowed|baseline|gpt-6-astra|\"features\"/);
    index = scenario.turns.findIndex(t => t.text === view.newMessages[0]);
    if (index === 1) assert.ok(view.currentTask.evidence.some(e => e.includes("方案已审定")));
    return declaredNativeClassification(scenario.turns[index]!, c.semantic!.model);
  }, new AbortController().signal);
  assert.equal(rows[2]!.classifierCalls, 0);
  assert.ok(rows.every(r => r.policyMatch));
});

test("candidate configuration rejects accidental activation without an expert model", async () => {
  const c = await config();
  assert.throws(() => parseConfig({ ...c, native: { expertPolicy: "constraints" } }), /expertPolicy/);
  assert.throws(() => parseConfig({ ...c, native: { ...c.native, expertPolicy: "invented" } }), /expertPolicy/);
});

test("native classifier CLI uses the selected env key, enforces a call budget and never invokes GPT", async t => {
  const scenario = (await cases("holdout"))[0]!, c = await config(true);
  const directory = await mkdtemp(join(tmpdir(), "fenjue-native-classifier-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const server = await serve(async (request, response) => {
    calls++;
    assert.equal(request.headers.authorization, "Bearer selected-native-key");
    let text = ""; for await (const chunk of request) text += chunk;
    assert.doesNotMatch(text, /ignored-secret|allowed|\"baseline\"/);
    const body = JSON.parse(text);
    assert.equal(Object.keys(body.questions).length, 6);
    const turn = scenario.turns.find(t => t.text === body.state.newMessages[0])!;
    const result = declaredNativeClassification(turn, "kev-latest"), base = jevResponse(result);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ...base, answers: { ...base.answers, constraints: { type: "choice", ...result.constraints } } }));
  });
  t.after(() => server.close());
  c.semantic = parseConfig({ ...c, semantic: { ...c.semantic, provider: "kev", endpoint: server.url + "/v1/systemone",
    model: "kev-latest", apiKeyEnv: "KEV_API_KEY" } }).semantic!;
  const configFile = join(directory, "config.json"), casesFile = join(directory, "cases.json"), envFile = join(directory, "gateway.env");
  await writeFile(configFile, JSON.stringify(c)); await writeFile(casesFile, JSON.stringify([scenario]));
  await writeFile(envFile, "KEV_API_KEY=selected-native-key\nUNRELATED_KEY=ignored-secret\n");
  const argv = [resolve("dist/scripts/evaluate-native-classifier.js"), "--config", configFile, "--cases", casesFile,
    "--policy", "constraints", "--env-file", envFile, "--live", "--max-calls"];
  await assert.rejects(() => promisify(execFile)(process.execPath, [...argv, "1"]), /max-calls/);
  assert.equal(calls, 0);
  const { stdout } = await promisify(execFile)(process.execPath, [...argv, "11"], { timeout: 10000 });
  const report = JSON.parse(stdout);
  assert.equal(report.mode, "live-classifier"); assert.equal(report.realGPTCalls, 0);
  assert.equal(report.liveClassifierCalls, 5); assert.equal(report.policyMatched, 6);
  assert.equal(report.policy, "constraints-native-v2");
  assert.match(report.datasetDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(stdout, /selected-native-key|ignored-secret/);
  assert.deepEqual(server.errors, []);
});
