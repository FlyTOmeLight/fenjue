import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record, type Config, type Route } from "./config.js";
import { QUESTIONS, CONSTRAINT_QUESTION, classificationPayload, type Features, type ConstraintChoice,
  type Classification, type Classify, type QuestionScores } from "./classification.js";
import { NativeSession, type NativeMessage } from "./native-session.js";
import { NativeRecords, type NativeEvent } from "./native-records.js";

export interface NativeEvaluationCase {
  id: string; group: string; split: "calibration" | "holdout";
  turns: { text: string; evidence?: string; features: Features; constraints: ConstraintChoice;
    reasons?: ("classified" | "continuation" | "low-confidence" | "prefix-rule")[];
    allowed: { baseline: Route[]; constraints: Route[] } }[];
}
export function parseNativeEvaluationCases(value: unknown): NativeEvaluationCase[] {
  if (!Array.isArray(value) || !value.length) throw new Error("原生评测集需要非空场景");
  const ids = new Set<string>(), groups = new Map<string, string>();
  for (const c of value) {
    if (!record(c) || typeof c.id !== "string" || !c.id || ids.has(c.id) || typeof c.group !== "string" || !c.group ||
        !["calibration", "holdout"].includes(String(c.split)) || !Array.isArray(c.turns) || !c.turns.length) throw new Error("无效原生评测场景");
    ids.add(c.id);
    if (groups.has(c.group) && groups.get(c.group) !== c.split) throw new Error("同一 group 不得跨校准集和冻结集");
    groups.set(c.group, String(c.split));
    for (const t of c.turns) {
      if (!record(t) || typeof t.text !== "string" || !t.text.trim() || (t.evidence !== undefined && typeof t.evidence !== "string") ||
          !record(t.features) || Object.entries(QUESTIONS).some(([k, q]) => !Object.hasOwn(q.criteria, String((t.features as any)[k]))) ||
          !Object.hasOwn(CONSTRAINT_QUESTION.criteria, String(t.constraints)) || !record(t.allowed) ||
          (t.reasons !== undefined && (!Array.isArray(t.reasons) || !t.reasons.length || t.reasons.some(r => !["classified", "continuation", "low-confidence", "prefix-rule"].includes(String(r))))) ||
          ["baseline", "constraints"].some(policy => {
            const routes = (t.allowed as Record<string, unknown>)[policy];
            return !Array.isArray(routes) || !routes.length || routes.some(r => !record(r) || typeof r.model !== "string" || !r.model ||
              !["low", "medium", "high"].includes(String(r.effort)));
          })) throw new Error(`无效原生评测轮次：${c.id}`);
    }
  }
  return value as NativeEvaluationCase[];
}

// Only dry-run plumbing uses labels. They are never part of a classifier view.
export function declaredNativeClassification(turn: NativeEvaluationCase["turns"][number], model: string, constraints = true): Classification {
  const questionScores = Object.fromEntries(Object.entries(turn.features).map(([k, choice]) => [k, {
    confidence: 1, probabilities: Object.fromEntries(Object.keys(QUESTIONS[k as keyof Features].criteria).map(o => [o, o === choice ? 1 : 0])),
  }])) as QuestionScores;
  return { model, features: { ...turn.features }, confidence: 1, questionScores, inputTokens: 0,
    ...(constraints ? { constraints: { choice: turn.constraints, confidence: 1,
      probabilities: { independent: turn.constraints === "independent" ? 1 : 0, coupled: turn.constraints === "coupled" ? 1 : 0 } } } : {}) };
}
export interface NativeEvaluationRow {
  case: string; split: string; turn: number; route: Route; allowed: Route[]; policyMatch: boolean;
  featureMatch: boolean | null; constraintMatch: boolean | null; reason: string; reasonMatch: boolean;
  classifierCalls: number; inputTokens: number; elapsedMs: number; maxRequestBytes: number;
  classification?: Classification; boundaryClassification?: Classification;
  held: unknown; routeSupport: unknown;
}

// Simulate acceptance and completion, but exercise the production NativeSession
// planner, task history, evidence, boundary passes and per-turn downgrade rules.
// This evaluates routing only; no Codex process or execution GPT is started.
export async function evaluateNativeCase(config: Config, scenario: NativeEvaluationCase,
  classify: Classify | undefined, signal: AbortSignal): Promise<NativeEvaluationRow[]> {
  const directory = await mkdtemp(join(tmpdir(), "fenjue-native-eval-"));
  const rows: NativeEvaluationRow[] = [], sent: NativeMessage[] = [], events: NativeEvent[] = [];
  let expected = scenario.turns[0]!, calls = 0, inputTokens = 0, maxRequestBytes = 0;
  const candidate = config.native?.expertPolicy === "constraints";
  const records = new NativeRecords(directory, undefined, [], message => { throw new Error(message); });
  const session = new NativeSession({ ...config, capture: undefined, native: { expertModel: config.native?.expertModel,
    expertPolicy: config.native?.expertPolicy }, semantic: { ...config.semantic!, mode: "auto" } }, records,
    m => sent.push(m), m => { if (m.error) throw new Error(m.error.message); }, e => events.push(e), async (view, cancel) => {
      calls++; maxRequestBytes = Math.max(maxRequestBytes, Buffer.byteLength(classificationPayload(view, config.semantic!, candidate)));
      const result = classify ? await classify(view, cancel) : declaredNativeClassification(expected, config.semantic!.model, candidate);
      inputTokens += result.inputTokens; return result;
    });
  let id = 0;
  const request = async (method: string, params: any) => {
    signal.throwIfAborted();
    const message = { id: ++id, method, params }; await session.fromClient(message); signal.throwIfAborted(); return message;
  };
  const stop = () => session.close(); signal.addEventListener("abort", stop, { once: true });
  try {
    const start = await request("thread/start", { threadSource: "user", ephemeral: false });
    session.fromServer({ id: start.id, result: { thread: { id: scenario.id },
      model: config.routes[config.semantic!.roles.balanced]!.model, reasoningEffort: "medium" } });
    for (const [index, turn] of scenario.turns.entries()) {
      expected = turn; calls = 0; inputTokens = 0; maxRequestBytes = 0; events.length = 0;
      const started = Date.now();
      const next = await request("turn/start", { threadId: scenario.id, input: [{ type: "text", text: turn.text }] });
      const submitted = sent.findLast(m => m.id === next.id && m.method === "turn/start");
      if (!submitted) throw new Error("评测轮次未提交");
      const turnId = `eval-${index}`;
      session.fromServer({ id: next.id, result: { turn: { id: turnId, status: "inProgress" } } });
      session.fromServer({ method: "turn/started", params: { threadId: scenario.id, turn: { id: turnId } } });
      const decision = events.findLast(e => e.type === "accepted")!;
      const classification = decision.classification as Classification | undefined;
      const boundary = decision.boundaryClassification as Classification | undefined;
      const allowed = turn.allowed[candidate ? "constraints" : "baseline"];
      const route = { model: submitted.params.model, effort: submitted.params.effort };
      rows.push({ case: scenario.id, split: scenario.split, turn: index + 1, route, allowed,
        policyMatch: allowed.some(r => r.model === route.model && r.effort === route.effort),
        featureMatch: classification ? (Object.keys(QUESTIONS) as (keyof Features)[]).every(k =>
          (k === "relation" ? boundary?.features.relation ?? classification.features.relation : classification.features[k]) === turn.features[k]) : null,
        constraintMatch: candidate && classification ? classification.constraints?.choice === turn.constraints : null,
        reason: String(decision.reason), reasonMatch: (turn.reasons ?? ["classified", "continuation"]).some(r => r === decision.reason),
        classifierCalls: calls, inputTokens, elapsedMs: Date.now() - started, maxRequestBytes,
        classification, boundaryClassification: boundary, held: decision.held, routeSupport: decision.routeSupport });
      session.fromServer({ method: "turn/completed", params: { threadId: scenario.id,
        turn: { id: turnId, status: "completed", items: turn.evidence ?
          [{ type: "agentMessage", id: `evidence-${index}`, phase: "final_answer", text: turn.evidence }] : [] } } });
    }
    return rows;
  } finally { signal.removeEventListener("abort", stop); session.close(); await rm(directory, { recursive: true, force: true }); }
}
