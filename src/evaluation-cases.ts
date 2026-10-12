import { readFile } from "node:fs/promises";
import { QUESTIONS, type Features } from "./classification.js";
import { ROLES, record, type Role } from "./config.js";
import type { ModelReview } from "./judge.js";

export interface EvaluationCase {
  id: string;
  source?: { kind: "daily"; thread: string; capture: string; reviewer: string; reviewed: true;
    reviewKind?: "human" | "model"; modelReview?: ModelReview };
  turns: { text: string; evidence?: string; features: Features; expected: { role: Role; effort: string } }[];
}
// Expected labels and provenance are never classifier input.
export async function evaluationCases(path: string | URL = new URL("../../evals/chinese-tasks.json", import.meta.url)): Promise<EvaluationCase[]> {
  return parseEvaluationCases(JSON.parse(await readFile(path, "utf8")));
}
export function parseEvaluationCases(cases: unknown): EvaluationCase[] {
  const ids = new Set<string>();
  if (!Array.isArray(cases) || !cases.length) throw new Error("评测集必须包含至少一个场景");
  for (const scenario of cases) {
    if (!record(scenario) || typeof scenario.id !== "string" || !scenario.id || ids.has(scenario.id) ||
        !Array.isArray(scenario.turns) || !scenario.turns.length) throw new Error("评测场景需要唯一 id 和非空 turns");
    ids.add(scenario.id);
    if (scenario.source !== undefined && (!record(scenario.source) || scenario.source.kind !== "daily" ||
        scenario.source.reviewed !== true || typeof scenario.source.reviewer !== "string" || !scenario.source.reviewer.trim() ||
        typeof scenario.source.thread !== "string" || typeof scenario.source.capture !== "string" ||
        (scenario.source.reviewKind !== undefined && !["human", "model"].includes(String(scenario.source.reviewKind))) ||
        (scenario.source.reviewKind === "model" && (!record(scenario.source.modelReview) ||
          scenario.source.modelReview.kind !== "model" || scenario.source.modelReview.approved !== true)))) {
      throw new Error(`评测场景 ${scenario.id} 的真实任务来源尚未审核`);
    }
    for (const turn of scenario.turns) {
      if (!record(turn) || typeof turn.text !== "string" || !turn.text.trim() ||
          (turn.evidence !== undefined && typeof turn.evidence !== "string") ||
          !record(turn.features) || Object.entries(QUESTIONS).some(([key, q]) => !Object.hasOwn(q.criteria, String((turn.features as Record<string, unknown>)[key]))) ||
          !record(turn.expected) || !ROLES.includes(turn.expected.role as Role) ||
          !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(turn.expected.effort))) {
        throw new Error(`评测场景 ${scenario.id} 包含无效任务、标签或预期路线`);
      }
    }
  }
  return cases as EvaluationCase[];
}
