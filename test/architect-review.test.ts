import test from "node:test";
import assert from "node:assert/strict";
import { completedWork, RepeatedErrors, runArchitectTask, type WorkTurn } from "../src/architect-review.js";
import { parseExecutionSuite, type ExecutionTask } from "../src/task-evaluation.js";

const task: ExecutionTask = { id: "repair", group: "repair", category: "diagnosis", origin: "synthetic", split: "calibration",
  snapshot: "snapshot", prompts: ["修复顺序", "补充 Unicode 约束"], reviewCheckpoints: ["plan", "repeated-error", "final"],
  acceptance: { argv: ["node", "verify.mjs"], timeoutMs: 1000 }, limits: { wallMs: 10000, tokens: 10000, toolCalls: 10 } };
const failure = (id: string, output = "AssertionError: wrong order") => ({ id, type: "commandExecution", command: "node test.mjs", exitCode: 1, aggregatedOutput: output });
const edit = (id: string) => ({ id, type: "fileChange", status: "completed" });

test("review experiment separates planning, implementation and final revision without revealing future inputs", async () => {
  const calls: string[] = [], inputs: string[][] = [];
  await runArchitectTask(task, {
    main: async (prompt, phase) => {
      calls.push(phase);
      if (phase === "implementation") assert.match(prompt, /修复顺序|Unicode/);
      return { threadId: "main", turnId: String(calls.length), answer: "方案或结果", items: [], status: "completed" };
    }, review: async (checkpoint, prompts) => { calls.push(checkpoint + "-review"); inputs.push([...prompts]); return "具体审查建议"; },
  });
  assert.deepEqual(calls, ["plan", "plan-review", "implementation", "implementation", "final-review", "revision"]);
  assert.deepEqual(inputs[0], ["修复顺序"]); assert.deepEqual(inputs[1], task.prompts);
});

test("repeated failures require an observed edit and exclude environment errors", () => {
  const errors = new RepeatedErrors();
  assert.equal(errors.observe([failure("a"), failure("a")]), undefined);
  assert.equal(errors.observe([failure("b")]), undefined);
  assert.match(errors.observe([edit("c"), failure("d")])!, /wrong order/);
  assert.equal(errors.observe([edit("e"), failure("f")]), undefined);
  for (const output of ["ERR_MODULE_NOT_FOUND", "FAIL: permission denied", "FAIL: ECONNRESET"]) {
    const tracker = new RepeatedErrors();
    assert.equal(tracker.observe([failure("a", output), edit("b"), failure("c", output)]), undefined);
  }
});

test("failed main work stops reviews, and each task has a three-review ceiling", async () => {
  let reviews = 0;
  await runArchitectTask(task, { main: async () => ({ threadId: "main", turnId: "failed", answer: "", items: [], status: "failed" }),
    review: async () => { reviews++; return "review"; } });
  assert.equal(reviews, 0);
  let turn = 0;
  await runArchitectTask({ ...task, prompts: ["first", "second", "third", "fourth"] }, {
    main: async (_prompt, phase) => {
      turn++;
      return { threadId: "main", turnId: String(turn), answer: "result", status: "completed",
        items: phase === "implementation" ? [failure(`a${turn}`, `AssertionError: failure ${turn}`), edit(`b${turn}`), failure(`c${turn}`, `AssertionError: failure ${turn}`)] : [] };
    }, review: async () => { reviews++; return "review"; },
  });
  assert.equal(reviews, 3);
});

test("final answers exclude private reasoning and duplicate items", () => {
  const answer = { id: "a", type: "agentMessage", phase: "final_answer", text: "公开结论" };
  const work = completedWork("thread", { id: "turn", status: "completed", items: [answer, answer, { id: "private", type: "reasoning", text: "private" }] });
  assert.equal(work.answer, "公开结论");
});

test("suite requires valid review checkpoints and an explicit reviewer model", () => {
  const strategies = [{ id: "baseline", kind: "sol-auto" }, { id: "review", kind: "advisor-auto", advisorRoute: { model: "astra", effort: "high" } }];
  assert.equal(parseExecutionSuite({ version: 1, tasks: [task], strategies }).strategies.length, 2);
  assert.throws(() => parseExecutionSuite({ version: 1, tasks: [{ ...task, reviewCheckpoints: ["unknown"] }], strategies }), /reviewCheckpoints/);
  assert.throws(() => parseExecutionSuite({ version: 1, tasks: [task], strategies: [strategies[0], { id: "review", kind: "advisor-auto" }] }), /advisorRoute/);
});
