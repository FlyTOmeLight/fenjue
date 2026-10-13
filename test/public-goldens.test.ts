import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { sampledTasks, candidateRoutes, assertSameExperiment, assertNoTools, main } from "../scripts/evaluate-public-goldens.js";

test("public gold sampling is order-independent and never puts answers or tests in prompts", () => {
  const rows = ["a", "b", "c"].map(id => ({ id, code: "def f(x): return x", input: "1", output: "SECRET_GOLD" }));
  assert.deepEqual(sampledTasks("cruxeval", rows, 2), sampledTasks("cruxeval", [...rows].reverse(), 2));
  assert.ok(sampledTasks("cruxeval", rows, 2).every(t => !t.prompt.includes("SECRET_GOLD")));
  const coding = sampledTasks("humanevalplus", [{ task_id: "x", prompt: "def f():", canonical_solution: "SECRET_SOLUTION", test: "SECRET_TEST" }], 1)[0]!;
  assert.ok(!coding.prompt.includes("SECRET_"));
});

test("route counterfactuals retain the actual selected model and deduplicate identical routes", async () => {
  assert.deepEqual(candidateRoutes({ model: "sol", effort: "low" }, "sol"), [{ model: "sol", effort: "low" }, { model: "sol", effort: "high" }]);
  assert.equal(candidateRoutes({ model: "astra", effort: "high" }, "sol")[0]!.model, "astra");
  await assert.rejects(main(["--live", "--max-classifier-calls", "47", "--max-model-calls", "36"]), /requires/);
});

test("CRUX gold verifier compares Python values, rejects expressions and preserves tuple/list distinction", () => {
  for (const [output, answer, expected] of [["{'x': [1]}", '{"x": [1]}', true], ["(1,)", "[1]", false], ["[1,1]", "[1]*2", false]] as const) {
    const result = spawnSync("python3", ["scripts/public-goldens-verifier.py"], {
      input: JSON.stringify({ dataset: "cruxeval", gold: { output }, answer }), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.valid, true); assert.equal(verdict.passed, expected);
  }
});

test("continuation refuses changed prompts and protocol input events are not tool calls", () => {
  const current = { startedAt: "later", tasks: [{ prompt: "original", goldDigest: "gold" }], minConfidence: 0.75 };
  assertSameExperiment(current, { ...current, startedAt: "earlier", runtime: {} });
  assert.throws(() => assertSameExperiment(current, { ...current, tasks: [{ prompt: "changed", goldDigest: "gold" }] }), /tasks/);
  assert.throws(() => assertSameExperiment(current, { ...current, minConfidence: 0.1 }), /minConfidence/);
  assertNoTools(["userMessage", "reasoning", "agentMessage"]);
  assert.throws(() => assertNoTools(["userMessage", "commandExecution"]), /commandExecution/);
});
