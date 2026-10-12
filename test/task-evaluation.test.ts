import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseExecutionSuite, snapshotFiles, copySnapshot, digest, inside, acceptTask, nativeFailureStatus, pairedReport,
  type ExecutionResult, type ExecutionTask } from "../src/task-evaluation.js";

async function temporary(t: any) {
  const path = await mkdtemp(join(tmpdir(), "fenjue-evaluation-test-"));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function task(): ExecutionTask {
  return { id: "repair", group: "project-a", category: "diagnosis", origin: "daily", split: "calibration", snapshot: "snapshot",
    prompts: ["Fix the failure"], acceptance: { argv: [process.execPath, "{suite}/verify.mjs"], timeoutMs: 2000 },
    limits: { wallMs: 10000, toolCalls: 5, tokens: 50000 } };
}
function suite() { return { version: 1, tasks: [task()], strategies: [
  { id: "baseline", kind: "sol-auto" }, { id: "candidate", kind: "expert-auto", expertModel: "gpt-6-astra" } ] }; }

test("execution sets cannot leak the same repository group into holdout", () => {
  const value = suite(); value.tasks.push({ ...task(), id: "rewrite", split: "holdout" });
  assert.throws(() => parseExecutionSuite(value), /group/);
  assert.throws(() => parseExecutionSuite({ ...suite(), tasks: [{ ...task(), limits: { wallMs: 0 } }] }), /无效执行任务/);
});

test("constraint admission is an explicit expert-auto evaluation candidate", () => {
  const candidate = { id: "constraints", kind: "expert-auto", expertModel: "gpt-6-astra", expertPolicy: "constraints" };
  const value = { ...suite(), strategies: [...suite().strategies, candidate] };
  assert.equal(parseExecutionSuite(value).strategies.length, 3);
  for (const bad of [{ ...candidate, expertPolicy: "invented" }, { ...candidate, kind: "sol-auto" }]) {
    assert.throws(() => parseExecutionSuite({ ...value, strategies: [value.strategies[0], bad] }), /expertPolicy/);
  }
});

test("snapshot copies preserve initial bytes, isolate variants and reject credentials, links and escape paths", async t => {
  const root = await temporary(t), source = join(root, "source"), a = join(root, "a"), b = join(root, "b");
  await mkdir(source); await writeFile(join(source, "code.mjs"), "original\n");
  const files = await snapshotFiles(source);
  await copySnapshot(source, a, files); await copySnapshot(source, b, files);
  await writeFile(join(a, "code.mjs"), "changed\n");
  assert.equal(await readFile(join(b, "code.mjs"), "utf8"), "original\n");
  assert.equal(digest(await snapshotFiles(b)), digest(files));
  await writeFile(join(source, ".env.local"), "SECRET=private");
  await assert.rejects(() => snapshotFiles(source), /凭据/); await rm(join(source, ".env.local"));
  await symlink(join(b, "code.mjs"), join(source, "link"));
  await assert.rejects(() => snapshotFiles(source), /符号链接/);
  assert.throws(() => inside(root, "../escape"), /目录内/);
});

test("acceptance distinguishes task failure from verifier crash and does not inherit credentials", async t => {
  const root = await temporary(t), workspace = join(root, "workspace"); await mkdir(workspace);
  const fixture = task();
  await writeFile(join(root, "verify.mjs"), `import {readFileSync} from 'node:fs';
const passed=readFileSync(process.env.FENJUE_WORKSPACE+'/result','utf8')==='fixed';
console.log(JSON.stringify({passed}));process.exitCode=passed?0:1;`);
  await writeFile(join(workspace, "result"), "broken");
  assert.deepEqual((await acceptTask(fixture, root, workspace, "unused")).valid, true);
  assert.equal((await acceptTask(fixture, root, workspace, "unused")).passed, false);
  await writeFile(join(workspace, "result"), "fixed");
  assert.equal((await acceptTask(fixture, root, workspace, "unused")).passed, true);
  await writeFile(join(root, "verify.mjs"), "throw new Error('verifier crashed')");
  assert.equal((await acceptTask(fixture, root, workspace, "unused")).valid, false);
  const previous = process.env.FENJUE_EVALUATION_SECRET; process.env.FENJUE_EVALUATION_SECRET = "private";
  try {
    await writeFile(join(root, "verify.mjs"), "console.log(JSON.stringify({passed:!process.env.FENJUE_EVALUATION_SECRET}))");
    assert.equal((await acceptTask(fixture, root, workspace, "unused")).passed, true);
  } finally { if (previous === undefined) delete process.env.FENJUE_EVALUATION_SECRET; else process.env.FENJUE_EVALUATION_SECRET = previous; }
});

test("acceptance timeout terminates a verifier instead of accepting partial output", async t => {
  const root = await temporary(t); await writeFile(join(root, "verify.mjs"), "console.log(JSON.stringify({passed:true}));setInterval(()=>{},1000)");
  const fixture = task(); fixture.acceptance.timeoutMs = 100;
  const result = await acceptTask(fixture, root, root, "unused");
  assert.equal(result.timedOut, true); assert.equal(result.valid, false); assert.equal(result.passed, false);
});

test("paired reports count quality losses, keep infrastructure failures visible and leave unknown usage unknown", () => {
  const value = parseExecutionSuite(suite());
  const base: ExecutionResult = { task: "repair", category: "diagnosis", split: "calibration", repeat: 1, strategy: "baseline",
    status: "completed", elapsedMs: 100, toolCalls: 2, usage: null, classifierCalls: 1, classifierTokens: 10, classifierMs: 5,
    routes: [], decisionReasons: ["classified"], acceptance: { passed: true, valid: true, exitCode: 0, timedOut: false, output: "" } };
  const candidate = { ...base, strategy: "candidate", acceptance: { ...base.acceptance!, passed: false, exitCode: 1 } };
  const report = pairedReport(value, [base, candidate]);
  assert.equal(report.pairs[0]!.losses, 1); assert.equal(report.summaries[0]!.tokens, null);
  assert.equal(report.admission, "not-decided");
  candidate.status = "infrastructure-error";
  assert.equal(pairedReport(value, [base, candidate]).pairs[0]!.infrastructurePairs, 1);
});

test("native account/network failures are separated from capacity limits and task failures", () => {
  for (const info of ["usageLimitExceeded", "rateLimitExceeded", "unauthorized", "serverOverloaded",
    { responseStreamDisconnected: { httpStatusCode: null } }, { httpConnectionFailed: { httpStatusCode: 503 } }]) {
    assert.equal(nativeFailureStatus(info), "infrastructure-error");
  }
  assert.equal(nativeFailureStatus("contextWindowExceeded"), "budget");
  assert.equal(nativeFailureStatus("sessionBudgetExceeded"), "budget");
  assert.equal(nativeFailureStatus("tooManyDenials"), "failed");
  assert.equal(nativeFailureStatus(undefined), "failed");
});
