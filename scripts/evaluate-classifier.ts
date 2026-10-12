import { readConfig, parseConfig, AUTO_MODEL } from "../src/config.js";
import { Router } from "../src/routing.js";
import { QUESTIONS, classificationPayload, createClassifier, type Classification, type QuestionScores } from "../src/classification.js";
import { evaluationCases } from "../src/evaluation-cases.js";

const args = process.argv.slice(2);
let path = "examples/semantic-shadow.json", casesPath = "evals/chinese-tasks.json", live = false, maxCalls = 0, minConfidence: number | undefined;
while (args.length) {
  const flag = args.shift();
  if (flag === "--live") { live = true; continue; }
  if (!["--config", "--cases", "--min-confidence", "--max-calls"].includes(String(flag))) throw new Error("用法：npm run eval:classifier -- [--config 文件] [--cases 文件] [--min-confidence 0–1] [--live --max-calls 次数]");
  const value = args.shift();
  if (!value) throw new Error(`${flag} 缺少值`);
  if (flag === "--config") path = value;
  else if (flag === "--cases") casesPath = value;
  else if (flag === "--min-confidence") minConfidence = Number(value);
  else maxCalls = Number(value);
}
const config = await readConfig(path);
if (!config.semantic) throw new Error("评测需要 semantic 配置");
if (minConfidence !== undefined) config.semantic = parseConfig({ ...config, semantic: { ...config.semantic, minConfidence } }).semantic!;
const cases = await evaluationCases(casesPath);
const realTasks = cases.every(c => c.source?.kind === "daily");
const totalTurns = cases.reduce((sum, c) => sum + c.turns.length, 0);
const callBudget = 2 * totalTurns - cases.length;
if (live && (!Number.isSafeInteger(maxCalls) || maxCalls < callBudget)) throw new Error(`完整验收集包含 ${totalTurns} 轮；换任务可能需要重评，请显式设置 --max-calls 至少 ${callBudget}，不会自动重试`);
const semantic = config.semantic;
if (live && semantic.apiKeyEnv && !process.env[semantic.apiKeyEnv]) throw new Error(`请先在本机环境变量设置 ${semantic.apiKeyEnv}；不要把密钥写入配置或评测文件`);
// Evaluate the active policy without issuing ANY GPT request, even in live mode.
const active = { ...config, semantic: { ...semantic, mode: "auto" as const } };
const classify = createClassifier(semantic);
const abort = new AbortController();
const stop = () => abort.abort();
process.on("SIGINT", stop); process.on("SIGTERM", stop);
let calls = 0, inputTokens = 0, maxRequestBytes = 0;
const rows: Record<string, unknown>[] = [];
try {
  for (const scenario of cases) {
    let expected = scenario.turns[0]!, turnCalls = 0;
    const router = new Router(active, async (view, signal) => {
      maxRequestBytes = Math.max(maxRequestBytes, Buffer.byteLength(classificationPayload(view, semantic)));
      turnCalls++;
      let observed: Classification;
      if (live) {
        if (calls >= maxCalls) throw new Error("评测调用次数已用完");
        calls++;
        observed = await classify(view, signal);
        inputTokens += observed.inputTokens;
      } else {
        // Dry run verifies plumbing against declared labels, never model accuracy.
        const questionScores = Object.fromEntries(Object.entries(expected.features).map(([key, choice]) => [key, {
          confidence: 1, probabilities: Object.fromEntries(Object.keys(QUESTIONS[key as keyof typeof QUESTIONS].criteria).map(option => [option, option === choice ? 1 : 0])),
        }])) as QuestionScores;
        observed = { model: semantic.model, features: expected.features, confidence: 1, questionScores, inputTokens: 0 };
      }
      return observed;
    });
    const history: unknown[] = [];
    try {
      for (const [index, turn] of scenario.turns.entries()) {
        abort.signal.throwIfAborted(); expected = turn; turnCalls = 0;
        if (turn.evidence) history.push({ type: "function_call_output", output: turn.evidence });
        history.push({ role: "user", content: turn.text });
        const started = Date.now();
        const prepared = await router.prepare({ model: AUTO_MODEL, prompt_cache_key: scenario.id, input: structuredClone(history) }, abort.signal);
        prepared.accept();
        const decision = prepared.decision!;
        const targetRoute = semantic.roles[turn.expected.role];
        // Score relation from the full-context boundary pass. The fresh pass
        // supplies complexity features; both raw responses remain inspectable.
        const result = turnCalls ? decision.classification : undefined, boundary = turnCalls ? decision.boundaryClassification : undefined;
        const features = result && { ...result.features, relation: boundary?.features.relation ?? result.features.relation };
        const questionScores = result && { ...result.questionScores, relation: boundary?.questionScores.relation ?? result.questionScores.relation };
        rows.push({ case: scenario.id, turn: index + 1, reason: decision.classificationReason,
          featureMatch: features ? (Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).every(key => features[key] === turn.features[key]) : null,
          features, expectedFeatures: turn.features, confidence: result?.confidence, decisionConfidence: decision.decisionConfidence,
          questionScores, classification: result, boundaryClassification: boundary, classificationPasses: turnCalls,
          route: decision.route, effort: decision.effort,
          expectedRoute: targetRoute, expectedEffort: turn.expected.effort,
          policyMatch: decision.route === targetRoute && decision.effort === turn.expected.effort,
          elapsedMs: Date.now() - started });
      }
    } finally { router.close(); }
  }
  const matched = rows.filter(row => row.policyMatch).length;
  const classified = rows.filter(row => row.features) as (Record<string, unknown> & { features: Classification["features"]; expectedFeatures: Classification["features"] })[];
  const accepted = rows.filter(row => row.reason === "classified");
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const underpoweredDeepTurns = rows.filter(row => row.expectedRoute === semantic.roles.deep &&
    (row.route !== semantic.roles.deep || efforts.indexOf(String(row.effort)) < efforts.indexOf(String(row.expectedEffort)))).length;
  const roles = [semantic.roles.fast, semantic.roles.balanced, semantic.roles.deep];
  const underpoweredTurns = rows.filter(row => roles.indexOf(String(row.route)) < roles.indexOf(String(row.expectedRoute)) ||
    efforts.indexOf(String(row.effort)) < efforts.indexOf(String(row.expectedEffort))).length;
  const report = { mode: live ? realTasks ? "live-classifier-real-tasks" : "live-classifier-synthetic-tasks" : "offline-declared-labels", provider: semantic.provider,
    datasetOrigin: realTasks ? "reviewed-daily-capture" : cases.some(c => c.source) ? "mixed" : "declared-cases",
    endpoint: semantic.endpoint, classifier: semantic.model, dataset: casesPath, minConfidence: semantic.minConfidence,
    liveClassifierCalls: calls, realGPTCalls: 0, inputTokens, maxRequestBytes, turns: totalTurns, policyMatched: matched,
    classifiedTurns: rows.filter(row => row.featureMatch !== null).length, featureMatched: rows.filter(row => row.featureMatch === true).length,
    acceptedClassifications: accepted.length, acceptedPolicyMatched: accepted.filter(row => row.policyMatch).length, underpoweredDeepTurns, underpoweredTurns,
    featureAgreement: Object.fromEntries((Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).map(key =>
      [key, { matched: classified.filter(row => row.features[key] === row.expectedFeatures[key]).length, total: classified.length }])),
    note: live ? `${realTasks ? "经审核的真实任务" : "声明样例"}上的分类与路由结果；不衡量 GPT 完成质量，也不是费用节省证明。` : "离线预演使用人工声明的特征，只检验状态与策略，不代表分类模型准确率。", rows };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (matched !== totalTurns || rows.some(row => row.featureMatch === false || !["classified", "continuation"].includes(String(row.reason)))) process.exitCode = 1;
} finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
