import test from "node:test";
import assert from "node:assert/strict";
import { evaluationCases } from "../src/evaluation-cases.js";
import { Router } from "../src/routing.js";
import { AUTO_MODEL } from "../src/config.js";
import { semanticConfig, classification } from "./fixtures.js";

test("Chinese multi-turn acceptance cases verify policy against declared labels, not Jev accuracy", async t => {
  for (const scenario of await evaluationCases()) {
    await t.test(scenario.id, async () => {
      let expected = scenario.turns[0]!;
      const router = new Router(semanticConfig(), async () => classification(expected.features));
      const history: unknown[] = [];
      for (const turn of scenario.turns) {
        expected = turn;
        if (turn.evidence) history.push({ type: "function_call_output", output: turn.evidence });
        history.push({ role: "user", content: turn.text });
        const prepared = await router.prepare({ model: AUTO_MODEL, prompt_cache_key: scenario.id, input: structuredClone(history) });
        prepared.accept();
        assert.equal(prepared.decision!.route, turn.expected.role, turn.text);
        assert.equal(prepared.decision!.effort, turn.expected.effort, turn.text);
      }
    });
  }
});
