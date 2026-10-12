import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readConfig } from "../src/config.js";
import { QUESTIONS, ClassificationError, classificationPayload, createClassifier, type Classification, type Features } from "../src/classification.js";
import { readTaskInput, taskView } from "../src/task-state.js";
import { evaluationCases } from "../src/evaluation-cases.js";

const args = process.argv.slice(2);
let leftPath = "examples/semantic-shadow.json", rightPath = "examples/kev-shadow.json";
let casesPath = "evals/chinese-validation.json", live = false, maxCalls = 0;
while (args.length) {
  const flag = args.shift();
  if (flag === "--live") { live = true; continue; }
  if (!["--left-config", "--right-config", "--cases", "--max-calls"].includes(String(flag))) {
    throw new Error("用法：npm run eval:compare -- [--left-config 文件] [--right-config 文件] [--cases 文件] [--live --max-calls 总次数]");
  }
  const value = args.shift();
  if (!value) throw new Error(`${flag} 缺少值`);
  if (flag === "--left-config") leftPath = value;
  else if (flag === "--right-config") rightPath = value;
  else if (flag === "--cases") casesPath = value;
  else maxCalls = Number(value);
}
const configs = await Promise.all([leftPath, rightPath].map(readConfig));
const sides = configs.map((config, index) => {
  if (!config.semantic) throw new Error("对照评测需要两份 semantic 配置");
  return { name: index === 0 ? "left" : "right", config: config.semantic, classify: createClassifier(config.semantic) };
});
const cases = await evaluationCases(casesPath);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// Each turn replays the same complete scenario history to both classifiers.
// Neither predictions, reference labels nor routing state determine this input.
const inputs = cases.flatMap(scenario => {
  const history: unknown[] = [];
  return scenario.turns.map((turn, index) => {
    if (turn.evidence) history.push({ type: "function_call_output", output: turn.evidence });
    history.push({ role: "user", content: turn.text });
    const view = taskView(readTaskInput({ input: structuredClone(history) }));
    for (const side of sides) classificationPayload(view, side.config);
    return { case: scenario.id, turn: index + 1, view, reference: turn.features,
      inputSHA256: hash(JSON.stringify({ state: view, questions: QUESTIONS })) };
  });
});
const plannedCalls = inputs.length * sides.length;
if (live) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < plannedCalls) throw new Error(`对照需要最多 ${plannedCalls} 次分类，请设置 --max-calls 至少 ${plannedCalls}`);
  // Check BOTH providers before sending any prompt, including to local Kev.
  for (const side of sides) if (side.config.apiKeyEnv && !process.env[side.config.apiKeyEnv]) {
    throw new Error(`缺少 ${side.config.apiKeyEnv}；尚未向任何分类器发请求`);
  }
}
const abort = new AbortController(), stop = () => abort.abort();
process.on("SIGINT", stop); process.on("SIGTERM", stop);
type Observation = { elapsedMs: number; classification?: Classification; error?: string };
const rows: { case: string; turn: number; inputSHA256: string; reference: Features; observations?: Record<string, Observation> }[] = [];
let calls = 0;
try {
  for (const [index, input] of inputs.entries()) {
    abort.signal.throwIfAborted();
    const row: typeof rows[number] = { case: input.case, turn: input.turn, inputSHA256: input.inputSHA256, reference: input.reference };
    if (live) {
      row.observations = {};
      for (const side of index % 2 ? [...sides].reverse() : sides) {
        abort.signal.throwIfAborted();
        const started = performance.now();
        try {
          calls++;
          const classification = await side.classify(structuredClone(input.view), abort.signal);
          row.observations[side.name] = { classification, elapsedMs: Math.round(performance.now() - started) };
        } catch (error) {
          abort.signal.throwIfAborted();
          row.observations[side.name] = { elapsedMs: Math.round(performance.now() - started), error: error instanceof ClassificationError ? error.code : "unavailable" };
        }
      }
    }
    rows.push(row);
  }
  const keys = Object.keys(QUESTIONS) as (keyof Features)[];
  const complete = rows.filter(row => sides.every(side => row.observations?.[side.name]?.classification));
  const summary = live ? Object.fromEntries(sides.map(side => {
    const measured = complete.map(row => ({ row, result: row.observations![side.name]!.classification! }));
    const attempted = rows.map(row => row.observations![side.name]!);
    return [side.name, { successfulCalls: attempted.filter(o => o.classification).length, errors: attempted.filter(o => o.error).length,
      referenceAgreementOnCompletePairs: Object.fromEntries(keys.map(key => [key, {
        matched: measured.filter(({ row, result }) => row.reference[key] === result.features[key]).length, total: measured.length,
        meanBrier: measured.length ? measured.reduce((sum, { row, result }) => sum + Object.entries(result.questionScores[key].probabilities)
          .reduce((score, [option, probability]) => score + (probability - Number(option === row.reference[key])) ** 2, 0), 0) / measured.length : null,
      }])), inputTokens: attempted.reduce((sum, o) => sum + (o.classification?.inputTokens ?? 0), 0) }];
  })) : undefined;
  const disagreements = live ? complete.filter(row => keys.some(key => row.observations!.left!.classification!.features[key] !== row.observations!.right!.classification!.features[key]))
    .map(row => ({ case: row.case, turn: row.turn })) : undefined;
  const report = { mode: live ? "live-paired-classifiers" : "paired-input-preflight", dataset: casesPath,
    datasetSHA256: hash(await readFile(casesPath, "utf8")), questions: QUESTIONS,
    providers: Object.fromEntries(sides.map(side => [side.name, { provider: side.config.provider, model: side.config.model,
      endpoint: side.config.endpoint, timeoutMs: side.config.timeoutMs }])),
    context: "fixed-full-history-replay", thresholdsApplied: false, turns: inputs.length, plannedClassifierCalls: plannedCalls,
    actualClassifierCalls: calls, realGPTCalls: 0, completePairs: live ? complete.length : undefined, summary, disagreements,
    note: "比较相同 state/questions 下的分类；标签是未独立裁决的参考，不把任一模型输出当真值。全历史重放包含继续，不等于在线多轮路由或 GPT 任务质量。Kev 的请求别名不证明服务端 checkpoint。", rows };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (live && complete.length !== rows.length) process.exitCode = 1;
} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
