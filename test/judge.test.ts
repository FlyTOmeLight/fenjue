import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { judgeCase, judgeQuality, compareQuality, caseJudgeInput, parseQualityInput, modelReviewedCase,
  runCodexJudge, judgeCommand, type JudgeOptions, type JudgeCall } from "../src/judge.js";
import { exportCases } from "../src/cases.js";
import { evaluationCases } from "../src/evaluation-cases.js";
import { parseNativeEvaluationCases, evaluateNativeCase, declaredNativeClassification } from "../src/native-evaluation.js";
import { semanticConfig } from "./fixtures.js";

const options: JudgeOptions = { model: "judge-fixture", effort: "high", timeoutMs: 5000 };
const features = { relation: "new", scope: "local", reasoning: "mechanical", uncertainty: "sufficient", consequence: "reversible" };
const label = { status: "pass", reason: "按已知接口整理示例", evidence: ["turn:1:text 写示例"],
  features, expected: { role: "fast", effort: "low" }, constraints: "independent" };
function draft() {
  return { version: 1, review: { reviewer: "old-human", approved: true, warnings: [], contexts: [] },
    case: { id: "daily-fixture", source: { kind: "daily", thread: "fixture-thread", capture: "fixture.jsonl" }, turns: [
      { text: "写示例", features: { secret: "old-label" }, expected: { role: "deep" }, predictedModel: "private-model" },
      { text: "只改标题", evidence: "first-answer", features: null, expected: null } ] },
    outcome: { quality: "accepted", trailingEvidence: ["future-final-answer"] } };
}
const quality = () => parseQualityInput({ kind: "text", requirements: ["只回复 OK"], criteria: [{ id: "exact", description: "回答恰好 OK" }],
  answer: "OK", evidence: [], executionStatus: "completed", verification: { status: "unknown", evidence: [] },
  model: "private-candidate-model" });

test("case judge sees only prior context, not future material, predictions or old labels", async () => {
  const calls: JudgeCall[] = [], original = draft();
  const reviewed = await judgeCase(original, async call => { calls.push(call); return label; }, options);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0]!.prompt, /只改标题|first-answer|future-final-answer|old-label|private-model/);
  assert.match(calls[1]!.prompt, /first-answer/);
  assert.doesNotMatch(calls[1]!.prompt, /future-final-answer|old-label|private-model/);
  assert.equal(original.review.approved, true);
  assert.equal(reviewed.review.approved, false);
  assert.equal(reviewed.review.reviewer, "");
  assert.equal(reviewed.review.model.approved, true);
  assert.equal(modelReviewedCase(reviewed)!.model, options.model);
  reviewed.case.turns[0].text = "changed";
  assert.throws(() => modelReviewedCase(reviewed), /已变化/);
});

test("missing capture context stays unknown without model calls and cannot be exported", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-judge-test-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const input = draft(); input.review.warnings = ["图片缺失"] as never[];
  const result = await judgeCase(input, async () => assert.fail("should not guess"), options);
  assert.equal(result.review.model.approved, false);
  assert.equal(result.case.turns[0].features, null);
  const path = join(temp, "unknown.json"); await writeFile(path, JSON.stringify(result));
  await assert.rejects(exportCases([path], join(temp, "cases.json")), /模型审核未通过/);
});

test("model-reviewed export retains provenance and supports native routing calibration", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-judge-test-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const result = await judgeCase(draft(), async () => label, options), path = join(temp, "review.json");
  await writeFile(path, JSON.stringify(result));
  const legacy = join(temp, "legacy.json"); await exportCases([path], legacy);
  const c = (await evaluationCases(legacy))[0]!;
  assert.equal(c.source!.reviewKind, "model"); assert.equal(c.source!.reviewer, "codex:judge-fixture");
  assert.equal(c.source!.modelReview!.labels.length, 2);
  const native = join(temp, "native.json"), config = semanticConfig();
  config.native = { expertModel: "fixture-expert" };
  config.routes.fast!.effort = "low"; config.routes.balanced!.effort = "medium"; config.routes.deep!.effort = "high";
  await exportCases([path], native, config);
  const saved = JSON.parse(await readFile(native, "utf8")), cases = parseNativeEvaluationCases(saved);
  assert.equal(cases[0]!.split, "calibration");
  assert.equal(saved[0].source.routeLabels, "declared-policy");
  assert.equal(saved[0].source.reviewKind, "model");
  assert.equal(cases[0]!.turns[0]!.allowed.baseline[0]!.effort, "low");
  const explicit = draft(); explicit.case.turns[0]!.text = "[deep] 写示例"; explicit.case.turns[1]!.text = "继续";
  let index = 0;
  const ruleReview = await judgeCase(explicit, async () => ({ ...label,
    features: { ...features, relation: index++ === 0 ? "new" : "continue" } }), options);
  await writeFile(path, JSON.stringify(ruleReview));
  config.rules = [{ prefix: "[deep]", route: "deep" }];
  const rulePath = join(temp, "rules.json"); await exportCases([path], rulePath, config);
  const ruleCase = parseNativeEvaluationCases(JSON.parse(await readFile(rulePath, "utf8")))[0]!;
  assert.deepEqual(ruleCase.turns.map(t => t.allowed.baseline[0]!.effort), ["high", "high"]);
  const rows = await evaluateNativeCase(config, ruleCase, undefined, new AbortController().signal);
  assert.ok(rows.every(r => r.policyMatch && r.reasonMatch));
  result.review.model.labels[0].features.scope = "cross_system";
  assert.throws(() => modelReviewedCase(result), /已变化/);
});

test("invalid judge labels and empty evidence are rejected", async () => {
  for (const invalid of [ { ...label, evidence: [] }, { ...label, features: { ...features, scope: "invented" } },
    { ...label, status: "unknown" }, { ...label, constraints: "invented" } ]) {
    await assert.rejects(judgeCase(draft(), async () => invalid, options));
  }
});

test("native daily export places preceding evidence before the matching request", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-judge-evidence-")); t.after(() => rm(temp, { recursive: true, force: true }));
  let index = 0;
  const reviewed = await judgeCase(draft(), async () => ({ ...label,
    features: { ...features, relation: index++ === 0 ? "new" : "continue" } }), options);
  const input = join(temp, "draft.json"), output = join(temp, "native.json");
  await writeFile(input, JSON.stringify(reviewed));
  const config = semanticConfig();
  config.native = { expertModel: "fixture-expert" };
  const views: { text: string; evidence: string[] }[] = [];
  await exportCases([input], output, config);
  const scenario = parseNativeEvaluationCases(JSON.parse(await readFile(output, "utf8")))[0]!;
  await evaluateNativeCase(config, scenario, async view => {
    const text = view.newMessages[0]!;
    views.push({ text, evidence: [...view.currentTask.evidence] });
    return declaredNativeClassification(scenario.turns.find(t => t.text === text)!, config.semantic!.model);
  }, new AbortController().signal);
  assert.deepEqual(views, [{ text: "写示例", evidence: [] }, { text: "只改标题", evidence: ["first-answer"] }]);
});

test("quality grading cannot override failed tests or certify untested code and incomplete execution", async () => {
  const run = async () => ({ checks: [{ id: "exact", status: "pass", reason: "一致", evidence: ["answer: OK"] }] });
  const rows = [
    { input: quality(), expected: "pass" },
    { input: { ...quality(), kind: "code" as const }, expected: "unknown" },
    { input: { ...quality(), executionStatus: "incomplete" as const }, expected: "unknown" },
    { input: { ...quality(), verification: { status: "fail" as const, evidence: ["AssertionError"] } }, expected: "fail" },
    { input: { ...quality(), kind: "code" as const, verification: { status: "pass" as const, evidence: ["1 test passed"] } }, expected: "pass" },
  ];
  for (const row of rows) assert.equal((await judgeQuality(row.input, run)).status, row.expected);
  const prompt: string[] = [];
  await judgeQuality(quality(), async call => { prompt.push(call.prompt); return run(); });
  assert.doesNotMatch(prompt[0]!, /private-candidate-model/);
  await assert.rejects(judgeQuality(quality(), async () => ({ checks: [] })), /未完整/);
  await assert.rejects(judgeQuality(quality(), async () => ({ checks: [{ id: "exact", status: "pass", reason: "yes", evidence: [] }] })), /缺少证据/);
});

test("pairwise comparison swaps order, flags position bias and applies verification gate", async () => {
  let i = 0;
  const calls: string[] = [], b = { ...quality(), answer: "BAD" };
  const result = await compareQuality([quality(), b], async call => {
    calls.push(call.prompt); return { winner: i++ === 0 ? "A" : "B", reason: "满足原要求", evidence: ["answer: OK"] };
  });
  assert.equal(result.winner, "A"); assert.equal(result.orderConsistent, true);
  assert.ok(calls[0]!.indexOf('"answer":"OK"') < calls[0]!.indexOf('"answer":"BAD"'));
  assert.ok(calls[1]!.indexOf('"answer":"BAD"') < calls[1]!.indexOf('"answer":"OK"'));
  const biased = await compareQuality([quality(), b], async () => ({ winner: "A", reason: "偏序", evidence: ["A: answer"] }));
  assert.equal(biased.winner, "unknown"); assert.equal(biased.orderConsistent, false);
  i = 0;
  const failed = await compareQuality([{ ...quality(), verification: { status: "fail", evidence: ["failed"] } }, b],
    async () => ({ winner: i++ === 0 ? "A" : "B", reason: "错误好评", evidence: ["A: answer"] }));
  assert.equal(failed.winner, "unknown");
});

test("Codex subprocess passes a schema and isolation flags, rejects tool use and timeout, cleans temporary files", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-judge-test-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const executable = join(temp, "fake-codex.cjs"), observed = join(temp, "observed.json");
  const writeExecutable = async (body: string) => writeFile(executable, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  await writeExecutable(`const fs=require('node:fs');let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({args,prompt,cwd:process.cwd()}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({ok:true}));});`);
  const call = { prompt: "synthetic judge input", schema: { type: "object" } };
  assert.deepEqual(await runCodexJudge(call, { ...options, executable }), { ok: true });
  const saved = JSON.parse(await readFile(observed, "utf8"));
  assert.equal(saved.prompt, call.prompt);
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--output-schema", "read-only", "project_doc_max_bytes=0", "features.multi_agent=false"]) assert.ok(saved.args.includes(flag), flag);
  await assert.rejects(readFile(join(saved.cwd, "schema.json")), /ENOENT/);
  await writeExecutable(`process.stdin.resume();process.stdout.write(JSON.stringify({item:{type:'command_execution'}})+String.fromCharCode(10));setInterval(()=>{},1000);`);
  await assert.rejects(runCodexJudge(call, { ...options, executable }), /尝试执行工具/);
  await writeExecutable(`process.stdin.resume();setInterval(()=>{},1000);`);
  await assert.rejects(runCodexJudge(call, { ...options, executable, timeoutMs: 50 }), /超时/);
});

test("judge CLI dry-run spends no calls, validates budget and refuses overwriting reports", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-judge-test-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const input = join(temp, "draft.json"), out = join(temp, "report.json"); await writeFile(input, JSON.stringify(draft()));
  await judgeCommand(["cases", "--draft", input, "--out", out]);
  const report = JSON.parse(await readFile(out, "utf8")); assert.equal(report.mode, "dry-run"); assert.equal(report.plannedCalls, 2);
  await assert.rejects(judgeCommand(["cases", "--draft", input, "--out", out]), /EEXIST/);
  await assert.rejects(judgeCommand(["cases", "--draft", input, "--out", join(temp, "live.json"), "--live", "--max-calls", "1"]), /max-calls 2/);
  assert.throws(() => caseJudgeInput({}), /分类草稿/);
});
