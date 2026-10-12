import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { readConfig } from "../src/config.js";
import { createClassifier, QUESTIONS, CONSTRAINT_QUESTION } from "../src/classification.js";
import { digest } from "../src/task-evaluation.js";
import { nativePolicy } from "../src/native-policy.js";
import { evaluateNativeCase, parseNativeEvaluationCases, type NativeEvaluationRow } from "../src/native-evaluation.js";

const args = process.argv.slice(2), flags = new Map<string, string>();
let live = false;
while (args.length) {
  const flag = args.shift()!;
  if (flag === "--live") { live = true; continue; }
  if (!["--config", "--cases", "--policy", "--max-calls", "--env-file"].includes(flag) || !args.length) throw new Error(`未知或缺值参数：${flag}`);
  flags.set(flag, args.shift()!);
}
const config = await readConfig(flags.get("--config") ?? "fenjue.config.json");
if (!config.semantic || !config.native?.expertModel) throw new Error("原生分类评测需要 semantic 与 native.expertModel");
const policy = flags.get("--policy") ?? "baseline";
if (!["baseline", "constraints"].includes(policy)) throw new Error("policy 必须为 baseline 或 constraints");
config.native = { expertModel: config.native.expertModel, ...(policy === "constraints" ? { expertPolicy: "constraints" as const } : {}) };
const casesPath = flags.get("--cases") ?? "evals/native-routing/calibration.json";
const cases = parseNativeEvaluationCases(JSON.parse(await readFile(casesPath, "utf8")));
const budget = cases.reduce((n, c) => n + 2 * c.turns.length - 1, 0), maxCalls = Number(flags.get("--max-calls") ?? 0);
if (live && (!Number.isSafeInteger(maxCalls) || maxCalls < budget)) throw new Error(`需要显式 --max-calls 至少 ${budget}；新任务边界可能需要两次分类`);
if (live && config.semantic.apiKeyEnv && flags.has("--env-file")) {
  const key = config.semantic.apiKeyEnv, value = parseEnv(await readFile(flags.get("--env-file")!, "utf8"))[key];
  if (!value) throw new Error(`env 文件缺少 ${key}`);
  process.env[key] = value;
}
if (live && config.semantic.apiKeyEnv && !process.env[config.semantic.apiKeyEnv]) throw new Error(`缺少环境变量 ${config.semantic.apiKeyEnv}`);
const classify = live ? createClassifier(config.semantic, undefined, undefined, policy === "constraints") : undefined;
const controller = new AbortController(), stop = () => controller.abort(new Error("Evaluation interrupted"));
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const rows: NativeEvaluationRow[] = []; let calls = 0;
try {
  for (const scenario of cases) rows.push(...await evaluateNativeCase(config, scenario, classify ? async (view, signal) => {
    if (calls >= maxCalls) throw new Error("分类预算耗尽");
    calls++; return classify(view, signal);
  } : undefined, controller.signal));
  const report = { mode: live ? "live-classifier" : "offline-declared-labels", policy: nativePolicy(config), dataset: casesPath,
    datasetDigest: digest(cases), questionnaireDigest: digest(policy === "constraints" ? { ...QUESTIONS, constraints: CONSTRAINT_QUESTION } : QUESTIONS),
    provider: config.semantic.provider, classifier: config.semantic.model, minConfidence: config.semantic.minConfidence,
    realGPTCalls: 0, liveClassifierCalls: calls, turns: rows.length, policyMatched: rows.filter(r => r.policyMatch).length,
    classifiedTurns: rows.filter(r => r.featureMatch !== null).length, featureMatched: rows.filter(r => r.featureMatch === true).length,
    constraintMatched: rows.filter(r => r.constraintMatch === true).length,
    inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
    maxRequestBytes: Math.max(...rows.map(r => r.maxRequestBytes)), rows,
    admission: "not-decided", note: "原生轮次路由评测；离线标签不代表分类准确率，分类结果不代表执行质量或节省。" };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (rows.some(r => !r.policyMatch || r.featureMatch === false || r.constraintMatch === false || !r.reasonMatch)) process.exitCode = 1;
} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
