import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionCapture, executionDraft, exportExecutionCases, registerAcceptance } from "../src/execution-capture.js";
import { parseConfig, readConfig } from "../src/config.js";
import { snapshotFiles, copySnapshot, digest, acceptTask } from "../src/task-evaluation.js";
import { semanticConfig } from "./fixtures.js";

const strategies = [{ id: "baseline", kind: "sol-auto" as const },
  { id: "candidate", kind: "expert-auto" as const, expertModel: "gpt-6-astra" }];
const verifier = `import {readFileSync} from 'node:fs';
const passed=readFileSync(process.env.FENJUE_WORKSPACE+'/src/result.txt','utf8')==='fixed';
console.log(JSON.stringify({passed}));process.exitCode=passed?0:1;`;
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "fenjue-execution-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"), directory = join(root, "cases"), warnings: string[] = [];
  await mkdir(join(project, "src"), { recursive: true }); await writeFile(join(project, "src/result.txt"), "broken");
  const capture = new ExecutionCapture({ directory, projects: [{ directory: project, paths: ["src"] }] }, ["test-secret-12345"], m => warnings.push(m));
  const promptFile = join(root, "prompt.txt"), verifierFile = join(root, "verify.mjs");
  await writeFile(promptFile, "Fix the failure"); await writeFile(verifierFile, verifier);
  const prepare = (prompt = "Fix the failure", task = "task") => capture.prepare("thread", task, project, prompt, new AbortController().signal);
  const casePath = async () => join(directory, (await readdir(directory)).find(n => n.startsWith("daily-"))!);
  async function review(split = "calibration") {
    const draft = await executionDraft(await casePath());
    const value = { ...draft, review: { approved: true, reviewer: "human" }, task: { ...draft.task, category: "diagnosis", split,
      acceptance: draft.task.acceptance ?? { verifier: verifierFile, timeoutMs: 2000 } } };
    const path = join(root, "draft.json"); await writeFile(path, JSON.stringify(value)); return { path, value };
  }
  const finish = () => { capture.observe("thread", "task", "turn", [{ kind: "user", text: "Fix the failure" }], false); capture.complete("thread", "task", "turn", "completed"); };
  return { root, project, directory, warnings, capture, prepare, casePath, review, finish, promptFile, verifierFile };
}

test("selected snapshots preserve bytes and skip unselected credentials and links", async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, ".env.local"), "PRIVATE=secret");
  await symlink(join(f.project, "src"), join(f.project, "unselected-link"));
  const files = await snapshotFiles(f.project, ["src"]);
  assert.deepEqual(Object.keys(files), ["src/result.txt"]);
  await copySnapshot(f.project, join(f.root, "copy"), files);
  assert.equal(digest(await snapshotFiles(join(f.root, "copy"))), digest(files));
  await assert.rejects(() => snapshotFiles(f.project, ["missing"]), /ENOENT/);
  await assert.rejects(() => snapshotFiles(f.project, ["unselected-link"]), /符号链接/);
  await assert.rejects(() => snapshotFiles(f.project, [".env.local"]), /凭据/);
});

test("execution capture configuration requires explicit paths and resolves from config location", async t => {
  const f = await fixture(t), c = semanticConfig();
  for (const paths of [[], ["."], ["../secret"], ["/private"]]) assert.throws(() => parseConfig({ ...c,
    capture: { directory: "daily", execution: { directory: "cases", projects: [{ directory: ".", paths }] } } }), /capture.execution/);
  const path = join(f.root, "config.json"); await writeFile(path, JSON.stringify({ ...c,
    capture: { directory: "daily", execution: { directory: "cases", projects: [{ directory: "project", paths: ["src"] }] } } }));
  const resolved = await readConfig(path);
  assert.equal(resolved.capture!.execution!.directory, f.directory);
  assert.equal(resolved.capture!.execution!.projects[0]!.directory, f.project);
});

test("only registered projects capture; original snapshot survives later edits and resume", async t => {
  const f = await fixture(t);
  await f.capture.prepare("other", "task", f.root, "hello", new AbortController().signal);
  await assert.rejects(() => readdir(f.directory), /ENOENT/);
  await f.prepare(); f.finish();
  const path = await f.casePath(); await writeFile(join(f.project, "src/result.txt"), "fixed"); await f.prepare();
  assert.equal(await readFile(join(path, "snapshot/src/result.txt"), "utf8"), "broken");
  f.capture.discard("thread", "task"); assert.equal((await executionDraft(path)).task.prompts.length, 1);
});

test("aborted and rejected unaccepted snapshots are removed", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await f.capture.prepare("thread", "task", f.project, "hello", controller.signal);
  await assert.rejects(() => readdir(f.directory), /ENOENT/);
  await f.prepare(); const path = await f.casePath(); f.capture.discard("thread", "task");
  await assert.rejects(() => readFile(join(path, "capture.json")), /ENOENT/); assert.deepEqual(f.warnings, []);
});

test("retrospective drafts require human approval and export a replayable calibration suite", async t => {
  const f = await fixture(t); await f.prepare(); f.finish();
  const blind = await executionDraft(await f.casePath());
  assert.equal(blind.review.approved, false); assert.equal(blind.task.category, null); assert.equal(blind.task.acceptance, null);
  assert.ok(!JSON.stringify(blind).includes("suggestion")); assert.ok(!JSON.stringify(blind).includes("outcomes"));
  const { path, value } = await f.review(), out = join(f.root, "suite");
  value.review.approved = false; await writeFile(path, JSON.stringify(value));
  await assert.rejects(() => exportExecutionCases([path], out, strategies), /人工审核/);
  value.review.approved = true; await writeFile(path, JSON.stringify(value));
  assert.equal(await exportExecutionCases([path], out, strategies), 1);
  const suite = JSON.parse(await readFile(join(out, "suite.json"), "utf8"));
  const task = suite.tasks[0], workspace = join(out, task.snapshot);
  assert.equal((await acceptTask(task, out, workspace, "unused")).passed, false);
  await writeFile(join(workspace, "src/result.txt"), "fixed");
  assert.equal((await acceptTask(task, out, workspace, "unused")).passed, true);
  assert.equal(JSON.parse(await readFile(join(out, "provenance.json"), "utf8"))[0].acceptanceTiming, "retrospective");
  await assert.rejects(() => exportExecutionCases([path], out, strategies), /EEXIST/);
  value.task.split = "holdout"; await writeFile(path, JSON.stringify(value));
  await assert.rejects(() => exportExecutionCases([path], join(f.root, "holdout"), strategies), /事后/);
});

test("pre-registered single prompt can enter holdout; first prompt and verifier are frozen", async t => {
  const f = await fixture(t);
  await registerAcceptance(f.directory, f.project, f.promptFile, f.verifierFile);
  await assert.rejects(() => registerAcceptance(f.directory, f.project, f.promptFile, f.verifierFile), /EEXIST/);
  await f.prepare("  Fix the failure\n"); f.finish();
  const capture = JSON.parse(await readFile(join(await f.casePath(), "capture.json"), "utf8"));
  assert.ok(capture.acceptancePlan);
  const { path, value } = await f.review("holdout");
  assert.equal(await exportExecutionCases([path], join(f.root, "holdout"), strategies), 1);
  await writeFile(value.task.acceptance.verifier, verifier + "\n// changed");
  await assert.rejects(() => exportExecutionCases([path], join(f.root, "changed"), strategies), /预登记验收已变化/);
  await f.capture.prepare("different-thread", "task", f.project, "Different task", new AbortController().signal);
  const names = (await readdir(f.directory)).filter(n => n.startsWith("daily-"));
  const captures = await Promise.all(names.map(n => readFile(join(f.directory, n, "capture.json"), "utf8").then(JSON.parse)));
  assert.equal(captures.filter(c => !!c.acceptancePlan).length, 1);
});

test("pre-registration cannot silently downgrade when its frozen verifier is missing", async t => {
  const f = await fixture(t), plan = await registerAcceptance(f.directory, f.project, f.promptFile, f.verifierFile);
  await rm(join(plan, "acceptance.mjs")); await f.prepare();
  assert.equal((await readdir(f.directory)).filter(n => n.startsWith("daily-")).length, 0);
  assert.equal(f.warnings.length, 1);
});

test("multi-turn feedback stays in calibration even with pre-registered first prompt", async t => {
  const f = await fixture(t); await registerAcceptance(f.directory, f.project, f.promptFile, f.verifierFile); await f.prepare(); f.finish();
  f.capture.observe("thread", "task", "second", [{ kind: "user", text: "Keep the old format too" }], false);
  f.capture.complete("thread", "task", "second", "completed");
  const { path, value } = await f.review("holdout");
  await assert.rejects(() => exportExecutionCases([path], join(f.root, "holdout"), strategies), /多轮反馈/);
  value.task.split = "calibration"; await writeFile(path, JSON.stringify(value));
  assert.equal(await exportExecutionCases([path], join(f.root, "calibration"), strategies), 1);
});

test("ongoing, concurrent, non-text, redacted and unknown-context inputs cannot directly export", async t => {
  for (const kind of ["ongoing", "concurrent", "non-text", "redacted", "unknown"] as const) {
    const f = await fixture(t); await f.prepare();
    f.capture.observe("thread", "task", "turn", [{ kind: "user", text: kind === "redacted" ? "test-secret-12345" : "Fix the failure", incomplete: kind === "non-text" }], kind === "unknown");
    if (kind === "concurrent") f.capture.observe("thread", "task", "turn", [{ kind: "user", text: "Another instruction" }], false);
    if (kind !== "ongoing") f.capture.complete("thread", "task", "turn", "completed");
    const { path } = await f.review(); await assert.rejects(() => exportExecutionCases([path], join(f.root, "out"), strategies), /上下文不完整或仍在执行/);
    if (kind === "redacted") assert.ok(!(await readFile(join(await f.casePath(), "items.jsonl"), "utf8")).includes("test-secret"));
  }
});

test("export detects snapshot, prompts and source-group changes", async t => {
  const f = await fixture(t); await f.prepare(); f.finish(); const { path, value } = await f.review();
  value.task.group = "another-project"; await writeFile(path, JSON.stringify(value));
  await assert.rejects(() => exportExecutionCases([path], join(f.root, "out"), strategies), /项目分组/);
  value.task.group = (await executionDraft(await f.casePath())).task.group;
  value.task.prompts.push("extra"); await writeFile(path, JSON.stringify(value));
  await assert.rejects(() => exportExecutionCases([path], join(f.root, "out"), strategies), /用户输入/);
  value.task.prompts.pop(); await writeFile(path, JSON.stringify(value));
  await writeFile(join(await f.casePath(), "snapshot/src/result.txt"), "tampered");
  await assert.rejects(() => exportExecutionCases([path], join(f.root, "out"), strategies), /起始快照/);
});

test("recording failures leave a durable incomplete case instead of a valid replay", async t => {
  const f = await fixture(t); await f.prepare(); f.finish(); const directory = await f.casePath();
  await rm(join(directory, "items.jsonl")); await mkdir(join(directory, "items.jsonl"));
  f.capture.observe("thread", "task", "turn", [{ kind: "evidence", text: "answer" }], false);
  assert.equal((await executionDraft(directory)).warnings.some(w => w.includes("写入失败")), true);
  const { path } = await f.review(); await assert.rejects(() => exportExecutionCases([path], join(f.root, "out"), strategies), /上下文不完整/);
  assert.equal(f.warnings.length, 1);
});

test("tasks CLI registers, lists, drafts and exports into the zero-model execution preflight", async t => {
  const f = await fixture(t), exec = promisify(execFile), cli = resolve("dist/src/cli.js");
  const run = (...args: string[]) => exec(process.execPath, [cli, "tasks", ...args], { timeout: 10000 });
  await run("register", "--dir", f.directory, "--project", f.project, "--prompt", f.promptFile, "--verifier", f.verifierFile);
  await f.prepare(); f.finish();
  const listed = JSON.parse((await run("list", "--dir", f.directory)).stdout);
  assert.equal(listed.cases.length, 1); assert.equal(listed.cases[0].complete, true);
  assert.equal(listed.cases[0].acceptanceTiming, "prospective");
  const path = join(f.root, "cli-draft.json"), out = join(f.root, "cli-suite");
  await run("draft", "--case", listed.cases[0].directory, "--out", path);
  const draft = JSON.parse(await readFile(path, "utf8"));
  assert.equal(draft.review.approved, false);
  draft.review = { approved: true, reviewer: "test reviewer" }; draft.task.category = "diagnosis"; draft.task.split = "holdout";
  await writeFile(path, JSON.stringify(draft)); await run("export", "--draft", path, "--out", out);
  const report = JSON.parse((await exec(process.execPath, [resolve("dist/scripts/evaluate-tasks.js"),
    "--suite", join(out, "suite.json"), "--dry-run", "--output", join(f.root, "preflight")], { timeout: 10000 })).stdout);
  assert.equal(report.paidCalls, 0); assert.equal(report.tasks, 1); assert.equal(report.plannedExecutions, 3);
  const initial = JSON.parse(await readFile(join(f.root, "preflight/preflight.json"), "utf8"));
  assert.equal(initial[0].initialAcceptance.valid, true); assert.equal(initial[0].initialAcceptance.passed, false);
});
