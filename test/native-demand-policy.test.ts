import test from "node:test";
import assert from "node:assert/strict";
import { nativePolicy, nativeSelection } from "../src/native-policy.js";
import type { Classification, DemandChoice, Features } from "../src/classification.js";
import { classification, semanticConfig } from "./fixtures.js";

function config() {
  const c = semanticConfig();
  c.routes.deep = { model: "fixture-fast", effort: "high" };
  c.native = { reasoningDemand: "auto", expertModel: "fixture-deep" };
  return c;
}
function answer(choice: DemandChoice, features: Partial<Features> = {}): Classification {
  return { ...classification(features), demand: { choice, confidence: 1,
    probabilities: { routine: choice === "routine" ? 1 : 0, multi_step: choice === "multi_step" ? 1 : 0, complex: choice === "complex" ? 1 : 0 } } };
}

test("auto demand separates complex implementation from ordinary implementation without changing model", () => {
  const c = config();
  for (const [choice, features, effort, reason] of [
    ["complex", { reasoning: "solution", scope: "multifile" }, "high", "demand"],
    ["multi_step", { reasoning: "solution" }, "medium", "demand"],
    ["routine", {}, "low", "demand"],
    ["routine", { reasoning: "solution" }, "medium", "implementation-floor"],
  ] as const) {
    const selected = nativeSelection(c, answer(choice, features));
    assert.deepEqual(selected.route, { model: "fixture-fast", effort });
    assert.equal(selected.effortDecision.reason, reason);
  }
  const floor = nativeSelection(c, answer("routine", { reasoning: "solution" }));
  assert.deepEqual(floor.effortDecision, { reason: "implementation-floor", from: "low", to: "medium" });
});

test("auto demand retains risk, unresolved-reference and missing-requirement floors", () => {
  const c = config();
  for (const features of [{ consequence: "sensitive" }, { uncertainty: "unknown_cause" },
    { reasoning: "architecture" }, { reasoning: "diagnosis" }] as const) {
    const selected = nativeSelection(c, answer("routine", features));
    assert.equal(selected.route.effort, "high");
    assert.equal(selected.effortDecision.reason, "risk");
  }
  for (const features of [{ relation: "uncertain" }, { uncertainty: "missing" }] as const) {
    const selected = nativeSelection(c, answer("routine", features), { model: "fixture-deep", effort: "high" });
    assert.deepEqual(selected.route, { model: "fixture-deep", effort: "high" });
    assert.equal(selected.effortDecision.reason, "context-floor");
  }
  const summary = nativeSelection(c, answer("routine", { relation: "continue" }), { model: "fixture-deep", effort: "high" });
  assert.deepEqual(summary.route, { model: "fixture-fast", effort: "low" });
});

test("auto aggregates routine and multi-step support, holds ambiguous depth and explains low-to-medium floor", () => {
  const c = config();
  const mixed = answer("multi_step");
  mixed.demand!.probabilities = { routine: 0.4, multi_step: 0.45, complex: 0.15 };
  assert.equal(nativeSelection(c, mixed).route.effort, "medium");
  mixed.demand!.probabilities = { routine: 0.1, multi_step: 0.5, complex: 0.4 };
  const held = nativeSelection(c, mixed, { model: "fixture-fast", effort: "high" });
  assert.equal(held.route.effort, "high");
  assert.deepEqual(held.effortDecision, { reason: "low-confidence", to: "high" });
  const implementation = answer("multi_step", { reasoning: "solution" });
  implementation.demand!.probabilities = { routine: 0.05, multi_step: 0.9, complex: 0.05 };
  implementation.questionScores.consequence.probabilities = { reversible: 0.58, contract: 0, sensitive: 0.42 };
  const ordinary = nativeSelection(c, implementation, { model: "fixture-fast", effort: "low" });
  assert.equal(ordinary.route.effort, "medium");
  assert.equal(ordinary.reason, "classified");
  assert.equal(ordinary.effortDecision.reason, "demand");
  implementation.demand!.probabilities = { routine: 0.1, multi_step: 0.5, complex: 0.4 };
  const floor = nativeSelection(c, implementation, { model: "fixture-fast", effort: "low" });
  assert.deepEqual(floor.effortDecision, { reason: "implementation-floor", from: "low", to: "medium" });
});

test("auto requires demand scores while shadow and disabled demand preserve stage routing", () => {
  const c = config();
  assert.equal(nativePolicy(c), "balanced-native-v6-demand-v1");
  c.native!.expertPolicy = "constraints";
  assert.equal(nativePolicy(c), "constraints-native-v3-demand-v1");
  delete c.native!.expertPolicy;
  assert.throws(() => nativeSelection(c, classification()), /missing-demand-score/);
  for (const mode of ["shadow", undefined] as const) {
    c.native!.reasoningDemand = mode;
    const selected = nativeSelection(c, answer("complex", { reasoning: "solution" }));
    assert.equal(selected.route.effort, "medium");
    assert.equal(selected.effortDecision.reason, "stage");
  }
  c.native!.reasoningDemand = "auto";
  c.semantic!.minConfidence = 0;
  assert.equal(nativeSelection(c, answer("routine")).route.effort, "low");
});
