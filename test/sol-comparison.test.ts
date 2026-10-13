import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFeatures, labelRoute, usage, summarize, main } from "../scripts/compare-sol-routing.js";
import { readConfig } from "../src/config.js";

test("categorical comparison downgrades after diagnosis but keeps the floor on ambiguous references", async () => {
  const config = await readConfig("examples/native-balanced.json");
  const base = parseFeatures({ relation: "continue", scope: "local", reasoning: "solution", uncertainty: "sufficient", consequence: "reversible" });
  const high = { model: "gpt-6-astra", effort: "high" };
  assert.deepEqual(labelRoute(config, base, high), { model: "gpt-6.1-sol", effort: "medium" });
  assert.deepEqual(labelRoute(config, { ...base, relation: "uncertain", uncertainty: "missing" }, high), high);
  assert.deepEqual(labelRoute(config, { ...base, relation: "new", reasoning: "mechanical" }, high), { model: "gpt-6.1-sol", effort: "low" });
  assert.throws(() => parseFeatures({ ...base, confidence: 0.9 }), /invalid-features/);
  assert.throws(() => parseFeatures({ ...base, reasoning: "invented" }), /invalid-features/);
});

test("token accounting preserves unknown fields and never adds cache or reasoning twice", () => {
  assert.deepEqual(usage({ input_tokens: 100 }), { input: 100, output: null, cachedInput: null, reasoning: null, total: null });
  assert.deepEqual(usage({ inputTokens: 100, outputTokens: 40, cachedInputTokens: 80, reasoningOutputTokens: 30, totalTokens: 140 }, true),
    { input: 100, output: 40, cachedInput: 80, reasoning: 30, total: 140 });
  const row = { repeat: 1, case: "x", turn: 1, view: { currentTask: { messages: [], evidence: [], incomplete: false }, newMessages: ["x"], evidence: [], incomplete: false },
    reference: parseFeatures({ relation: "new", scope: "local", reasoning: "mechanical", uncertainty: "sufficient", consequence: "reversible" }),
    allowed: [{ model: "sol", effort: "low" }], inputDigest: "fixture", observations: { sol: { elapsedMs: 10, usage: usage(null), error: "timeout" } } };
  const summary = summarize([row], "sol");
  assert.equal(summary.errors, 1); assert.equal(summary.routeMatches, 0); assert.equal(summary.usage.total, null);
});

test("experiment defaults to preflight and enforces the live call budget before launching providers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "fenjue-sol-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = join(directory, "report.json");
  await main(["--out", out]);
  const manifest = JSON.parse(await readFile(out, "utf8"));
  assert.equal(manifest.mode, "preflight"); assert.equal(manifest.plannedCalls, 64);
  await assert.rejects(main(["--live", "--max-calls", "63", "--out", join(directory, "live.json")]), /至少 64/);
});
