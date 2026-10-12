import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classification, jevResponse, kevConfig, readJSON, serve } from "./fixtures.js";

test("paired CLI fixes both inputs, preflights all credentials, and reports incomplete pairs separately", async t => {
  const seen: { side: string; body: Record<string, any> }[] = [];
  const local = await serve(async (req, res) => {
    const side = req.url!.slice(1), body = await readJSON(req);
    seen.push({ side, body });
    assert.equal(req.headers.authorization, side === "left" ? undefined : "Bearer right-fixture-key");
    assert.equal(body.model, `fixture-${side}`);
    if (side === "right" && body.state.newMessages.length === 3) {
      res.writeHead(503); res.end("provider unavailable"); return;
    }
    const features = side === "right" ? { relation: "uncertain", reasoning: "architecture" } as const : {};
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(jevResponse({ ...classification(features), model: body.model })));
  });
  t.after(() => local.close());
  const temp = await mkdtemp(join(tmpdir(), "fenjue-paired-eval-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const side of ["left", "right"]) {
    const c = kevConfig(`${local.url}/${side}`);
    c.semantic!.model = `fixture-${side}`;
    if (side === "right") c.semantic!.apiKeyEnv = "FENJUE_COMPARE_TEST_KEY";
    await writeFile(join(temp, `${side}.json`), JSON.stringify(c));
  }
  // Deliberately artificial labels exercise accounting; they are not a quality benchmark.
  const texts = ["把 abc 转为大写", "继续", "补充：只返回结果"];
  await writeFile(join(temp, "cases.json"), JSON.stringify([{ id: "paired-replay", turns: texts.map((text, i) => ({
    text, ...(i === 2 ? { evidence: "已有转换结果 ABC" } : {}), features: classification().features,
    expected: { role: "fast", effort: "low" },
  })) }]));
  const run = (args: string[], key = false) => promisify(execFile)(process.execPath, [resolve("dist/scripts/compare-classifiers.js"),
    "--left-config", join(temp, "left.json"), "--right-config", join(temp, "right.json"), "--cases", join(temp, "cases.json"), ...args], {
    env: { PATH: process.env.PATH, ...(key ? { FENJUE_COMPARE_TEST_KEY: "right-fixture-key" } : {}) }, timeout: 15000,
  });
  const dry = JSON.parse((await run([])).stdout);
  assert.equal(dry.mode, "paired-input-preflight"); assert.equal(dry.plannedClassifierCalls, 6);
  assert.equal(dry.actualClassifierCalls, 0); assert.equal(dry.summary, undefined);
  await assert.rejects(run(["--live", "--max-calls", "5"], true), /至少 6/);
  await assert.rejects(run(["--live", "--max-calls", "6"]), /缺少 FENJUE_COMPARE_TEST_KEY/);
  assert.equal(seen.length, 0);

  let stdout = "";
  await assert.rejects(run(["--live", "--max-calls", "6"], true), (error: any) => {
    assert.equal(error.code, 1); stdout = error.stdout; return true;
  });
  const report = JSON.parse(stdout);
  assert.equal(report.actualClassifierCalls, 6); assert.equal(report.realGPTCalls, 0);
  assert.equal(report.completePairs, 2); assert.equal(report.thresholdsApplied, false);
  assert.deepEqual(report.disagreements, [{ case: "paired-replay", turn: 1 }, { case: "paired-replay", turn: 2 }]);
  assert.equal(report.summary.left.successfulCalls, 3); assert.equal(report.summary.right.successfulCalls, 2);
  assert.equal(report.summary.right.errors, 1); assert.equal(report.rows[2].observations.right.error, "http-503");
  assert.equal(report.summary.left.inputTokens, 300); assert.equal(report.summary.right.inputTokens, 200);
  assert.deepEqual(report.summary.left.referenceAgreementOnCompletePairs.relation, { matched: 2, total: 2, meanBrier: 0 });
  assert.deepEqual(report.summary.right.referenceAgreementOnCompletePairs.relation, { matched: 0, total: 2, meanBrier: 2 });
  assert.deepEqual(seen.map(s => s.side), ["left", "right", "right", "left", "left", "right"]);
  for (let i = 0; i < 3; i++) {
    const pair = seen.slice(i * 2, i * 2 + 2);
    assert.deepEqual(pair[0]!.body.state, pair[1]!.body.state);
    assert.deepEqual(pair[0]!.body.questions, pair[1]!.body.questions);
    const state = pair[0]!.body.state;
    assert.deepEqual(state.newMessages, texts.slice(0, i + 1));
    assert.deepEqual(state.currentTask.messages, []);
    assert.deepEqual(state.evidence, i === 2 ? ["已有转换结果 ABC"] : []);
    assert.doesNotMatch(JSON.stringify(state), /features|expected|reference|uncertain|architecture/);
    assert.equal(report.rows[i].inputSHA256, dry.rows[i].inputSHA256);
  }
  assert.doesNotMatch(stdout, /right-fixture-key/);
  assert.deepEqual(local.errors, []);
});
