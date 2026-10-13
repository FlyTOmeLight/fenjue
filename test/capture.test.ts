import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCapture, redactCapture } from "../src/capture.js";
import { captureFrames, draftCase, exportCases } from "../src/cases.js";
import { evaluationCases } from "../src/evaluation-cases.js";
import { fingerprint } from "../src/task-state.js";
import { readConfig, PROXY_HEADER } from "../src/config.js";
import { startProxy } from "../src/proxy.js";
import { config, catalog, models, request, classification, serve } from "./fixtures.js";

test("redaction handles long ordinary words without blocking the native gateway", async () => {
  const script = `import assert from 'node:assert/strict';
    import { redactCapture } from './dist/src/capture.js';
    const word = 'a'.repeat(200000);
    assert.equal(redactCapture(word + ' API_KEY="private-value"'), word + ' API_KEY="[REDACTED]"');`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 3000 });
});

test("daily capture deduplicates history, redacts private text and creates blind drafts without future evidence", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-capture-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const capture = createCapture(join(temp, "daily"), "123-1", ["known-gateway-secret"], () => assert.fail("Unexpected write failure"));
  const history: unknown[] = [{ role: "developer", content: "private system instructions" },
    { role: "user", content: "<environment_context>private environment</environment_context>" },
    { role: "user", content: "检查报错 known-gateway-secret，保留原接口" }];
  const body = () => ({ ...request(), input: structuredClone(history), tools: [{ name: "private-tool-schema" }] });
  const original = body(); capture.observe(original, 1); assert.deepEqual(original, body());
  capture.observe(body(), 2);
  history.push({ role: "assistant", content: "正在排查" }, { type: "function_call_output", output: "error=timeout; API_KEY=another-secret-value" });
  capture.observe(body(), 3); capture.observe(body(), 4);
  history.push({ role: "user", content: "继续定位，不要改接口" }, { type: "function_call_output", output: "future evidence" });
  capture.observe(body(), 5);
  const frames = await captureFrames(capture.path); assert.equal(frames.length, 3);
  assert.equal(frames.flatMap(f => f.items).filter(i => i.kind === "user").length, 2);
  const raw = await readFile(capture.path, "utf8");
  assert.doesNotMatch(raw, /known-gateway-secret|another-secret-value|private system|private environment|private-tool-schema/);
  assert.equal((await stat(capture.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(temp, "daily"))).mode & 0o777, 0o700);
  const draft = await draftCase(capture.path, fingerprint("thread-1"));
  assert.equal(draft.case.turns.length, 2); assert.equal(draft.case.turns[0]!.evidence, undefined);
  assert.match(draft.case.turns[1]!.evidence!, /timeout/); assert.doesNotMatch(draft.case.turns[1]!.evidence!, /future evidence/);
  assert.equal(draft.case.turns[1]!.features, null); assert.equal(draft.case.turns[1]!.expected, null);
  assert.equal(draft.review.approved, false); assert.doesNotMatch(JSON.stringify(draft), /suggestedModel|decisionConfidence|questionScores/);
  assert.equal(redactCapture('Authorization: Bearer abc123.abc API_KEY="private-one" password: secret-two sk-proj-abcdefghijklm'),
    'Authorization: Bearer [REDACTED] API_KEY="[REDACTED]" password: [REDACTED] [REDACTED]');
  assert.deepEqual(JSON.parse(redactCapture('{"api_key":"private-value","enabled":true}')), { api_key: "[REDACTED]", enabled: true });
});

test("incremental turns retain tool evidence; changed histories and non-text inputs require context review", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-capture-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const capture = createCapture(temp, "123-2", [], () => assert.fail());
  capture.observe(request("设计模块"), 1);
  capture.observe({ ...request(), input: [{ type: "function_call_output", output: "design evidence" }] }, 2);
  capture.observe(request("再加限制"), 3);
  const draft = await draftCase(capture.path, fingerprint("thread-1"));
  assert.equal(draft.case.turns[1]!.evidence, "design evidence");
  capture.observe({ ...request(), input: [{ role: "user", content: "重写后的目标" }, { role: "user", content: [
    { type: "input_text", text: "见图片" }, { type: "input_image", image_url: "private-image" }] }] }, 4);
  const changed = await draftCase(capture.path, fingerprint("thread-1"));
  assert.equal(changed.review.warnings.length, 2);
  assert.doesNotMatch(await readFile(capture.path, "utf8"), /private-image/);
  await writeFile(capture.path, '{"partial":', { flag: "a" });
  assert.equal((await captureFrames(capture.path)).length, 4);
});

test("recording failures warn once without breaking accepted responses", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-capture-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = join(temp, "daily"); let warnings = 0;
  const capture = createCapture(directory, "123-3", [], () => warnings++);
  await rm(directory, { recursive: true }); await writeFile(directory, "not a directory");
  assert.doesNotThrow(() => capture.observe(request(), 1));
  assert.doesNotThrow(() => capture.observe(request("next"), 2)); assert.equal(warnings, 1);
});

test("only accepted upstream requests enter capture; retries preserve SSE and produce one user turn", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-capture-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const capture = createCapture(temp, "123-4", [], () => assert.fail()); let status = 503;
  const upstream = await serve((_req, res) => { res.writeHead(status); res.end("data: 中文🙂\n\n"); }); t.after(() => upstream.close());
  const c = config(upstream.url), proxy = await startProxy(c, catalog(c), undefined, undefined, capture.observe); t.after(() => proxy.close());
  async function send() {
    const response = await fetch(proxy.url + "/responses", { method: "POST", headers: { [PROXY_HEADER]: proxy.token, authorization: "Bearer must-not-be-recorded" }, body: JSON.stringify(request()) });
    assert.equal(response.status, status); assert.equal(await response.text(), "data: 中文🙂\n\n");
  }
  await send(); assert.equal((await captureFrames(capture.path)).length, 0);
  status = 200; await send(); await send();
  assert.equal((await captureFrames(capture.path)).length, 1);
  assert.doesNotMatch(await readFile(capture.path, "utf8"), /must-not-be-recorded/);
});

test("unreviewed or unlabelled drafts cannot become evaluation cases; reviewed cases replay through the existing CLI", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-case-review-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const capture = createCapture(temp, "123-5", [], () => assert.fail()); capture.observe(request("将 abc 转成大写"), 1);
  const draft = await draftCase(capture.path, fingerprint("thread-1")), path = join(temp, "draft.json"), out = join(temp, "cases.json");
  await writeFile(path, JSON.stringify(draft)); await assert.rejects(exportCases([path], out), /尚未完成人工审核/);
  draft.review.approved = true; draft.review.reviewer = "test reviewer";
  await writeFile(path, JSON.stringify(draft)); await assert.rejects(exportCases([path], out), /无效任务、标签/);
  const labelled = { ...draft, case: { ...draft.case, turns: draft.case.turns.map(turn => ({ ...turn,
    features: classification().features, expected: { role: "fast", effort: "low" } })) } };
  await writeFile(path, JSON.stringify(labelled)); await exportCases([path], out);
  assert.equal((await evaluationCases(out))[0]!.source!.reviewer, "test reviewer");
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  await assert.rejects(exportCases([path], out), /EEXIST/);
  await assert.rejects(exportCases([path, path], join(temp, "duplicate.json")), /同一会话/);
  const result = await promisify(execFile)(process.execPath, [resolve("dist/scripts/evaluate-classifier.js"), "--cases", out], { timeout: 10000 });
  const report = JSON.parse(result.stdout); assert.equal(report.datasetOrigin, "reviewed-daily-capture");
  assert.equal(report.policyMatched, 1); assert.equal(report.liveClassifierCalls, 0);
});

test("daily startup resolves capture paths and loads only the selected classifier key from an env file", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fenjue-daily-start-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const catalogPath = join(temp, "models.json"), configPath = join(temp, "config.json"), envPath = join(temp, ".env"), output = join(temp, "observed.json");
  await writeFile(catalogPath, JSON.stringify(models()));
  const c = { ...config("http://127.0.0.1:1"), catalog: "models.json", capture: { directory: "daily" },
    routes: { ...config("http://127.0.0.1:1").routes, balanced: { model: "fixture-fast", effort: "medium" } },
    semantic: { provider: "kev", mode: "shadow", model: "kev-test", apiKeyEnv: "FENJUE_TEST_GATEWAY_KEY", roles: { fast: "fast", balanced: "balanced", deep: "deep" } } };
  await writeFile(configPath, JSON.stringify(c)); await writeFile(envPath, "FENJUE_TEST_GATEWAY_KEY=local-fixture-secret\nUNRELATED_ENV_ENTRY=should-not-load\n");
  const executable = join(temp, "codex-fixture");
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(process.env.OBSERVED,JSON.stringify({selected:process.env.FENJUE_TEST_GATEWAY_KEY,other:process.env.UNRELATED_ENV_ENTRY,args:process.argv.slice(2)}));`, { mode: 0o700 });
  assert.equal((await readConfig(configPath)).capture!.directory, join(temp, "daily"));
  const result = await promisify(execFile)(process.execPath, [resolve("dist/src/cli.js"), "codex", "--config", configPath,
    "--env-file", envPath, "--log-dir", join(temp, "logs"), "--", "literal $(data)"], {
    env: { PATH: process.env.PATH, OBSERVED: output, FENJUE_CODEX_BIN: executable }, timeout: 15000 });
  const seen = JSON.parse(await readFile(output, "utf8")); assert.equal(seen.selected, "local-fixture-secret");
  assert.equal(seen.other, undefined); assert.ok(seen.args.includes("literal $(data)"));
  assert.match(result.stderr, /本地任务采集/); assert.doesNotMatch(result.stderr, /local-fixture-secret/);
});
