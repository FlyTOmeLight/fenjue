import { record, type Config, type Route } from "./config.js";
import { ClassificationError, type Classification } from "./classification.js";

export const NATIVE_POLICY = "balanced-native-v5";
export function nativePolicy(config: Pick<Config, "native">): string {
  return config.native?.expertPolicy === "constraints" ? "constraints-native-v2" : NATIVE_POLICY;
}
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export function mainRoute(config: Config): Route {
  return config.routes[config.semantic!.roles.balanced]!;
}

// Capability validation is independent of the legacy Responses prompt contract.
// Native Codex owns each model's prompts, tools and context limits.
export function validateNativeCatalog(value: unknown, config: Config): void {
  if (!config.semantic) throw new Error("原生路由需要 semantic 分类配置");
  const main = mainRoute(config).model;
  for (const [role, effort] of [["fast", "low"], ["balanced", "medium"], ["deep", "high"]] as const) {
    const route = config.routes[config.semantic.roles[role]]!;
    if (route.model !== main || route.effort !== effort) throw new Error("原生均衡策略的 fast/balanced/deep 需为同一主模型的 low/medium/high");
  }
  if (!record(value) || !Array.isArray(value.models)) throw new Error("无效原生模型目录");
  const candidates = [...Object.values(config.routes), ...(config.native?.expertModel ?
    ["medium", "high"].map(effort => ({ model: config.native!.expertModel!, effort })) : []),
    ...(config.native?.review ? [config.native.review] : [])];
  for (const route of candidates) {
    const model = value.models.find(m => record(m) && m.slug === route.model);
    if (!record(model) || !Array.isArray(model.supported_reasoning_levels) ||
        !model.supported_reasoning_levels.some(e => record(e) && e.effort === route.effort)) {
      throw new Error(`原生目录不支持 ${route.model} / ${route.effort}`);
    }
    if (config.auth === "api-key" && model.supported_in_api === false) throw new Error(`${route.model} 未声明 API 支持`);
  }
}

export interface NativeSelection {
  route: Route;
  reason: "classified" | "low-confidence";
  support: { model: { main: number; expert: number }; effort: { low: number; ordinary: number; high: number } };
  held: ("model" | "effort")[];
}

export function nativeSelection(config: Config, classification: Classification, previous?: Route): NativeSelection {
  const f = classification.features, q = classification.questionScores;
  const main = mainRoute(config).model, expert = config.native?.expertModel;
  const threshold = config.semantic!.minConfidence;
  const p = {
    scope: q.scope.probabilities, reasoning: q.reasoning.probabilities,
    uncertainty: q.uncertainty.probabilities, consequence: q.consequence.probabilities,
  };
  // Aggregate alternatives that lead to the same decision. These are separate
  // per-question supports, not a joint probability of task success.
  const constraints = config.native?.expertPolicy === "constraints";
  if (constraints && !classification.constraints) throw new ClassificationError("missing-constraint-score");
  const mainSupport = !expert ? 1 : constraints ? classification.constraints!.probabilities.independent : p.scope.local + p.scope.multifile;
  const expertSupport = !expert ? 0 : constraints ? classification.constraints!.probabilities.coupled : p.scope.cross_system;
  const ordinarySupport = Math.min(p.reasoning.mechanical + p.reasoning.solution,
    1 - p.uncertainty.unknown_cause, 1 - p.consequence.sensitive);
  const highSupport = Math.max(p.reasoning.architecture + p.reasoning.diagnosis,
    p.uncertainty.unknown_cause, p.consequence.sensitive);
  const lowSupport = Math.min(mainSupport, ordinarySupport, p.reasoning.mechanical, p.consequence.reversible);
  const held: NativeSelection["held"] = [];
  let model: string;
  if (expertSupport > 0 && expertSupport >= threshold && expert) model = expert;
  else if (mainSupport > 0 && mainSupport >= threshold) model = main;
  else { model = expert && previous?.model === expert ? expert : main; held.push("model"); }
  let effort: string;
  if (highSupport > 0 && highSupport >= threshold) effort = "high";
  else if (ordinarySupport > 0 && ordinarySupport >= threshold) effort = lowSupport > 0 && lowSupport >= threshold ? "low" : "medium";
  else {
    effort = previous?.effort ?? mainRoute(config).effort;
    // A confidently identified implementation stage needs at least the ordinary
    // floor, even when consequence uncertainty prevents adopting the whole route.
    if (effort === "low" && f.relation !== "uncertain" && p.reasoning.solution >= threshold) effort = "medium";
    held.push("effort");
  }
  const resolvedReferenceSupport = q.relation.probabilities.new + q.relation.probabilities.continue + q.relation.probabilities.correction;
  if (previous && (f.relation === "uncertain" || resolvedReferenceSupport < threshold || f.uncertainty === "missing")) {
    // Unclear task references and missing requirements still prohibit lowering
    // the accepted floor. New/continue/correction ambiguity alone does not change
    // the current stage's needs; task-boundary detection remains separate.
    if (previous.model === expert && model !== expert) { model = previous.model; held.push("model"); }
    if (EFFORTS.indexOf(previous.effort) > EFFORTS.indexOf(effort)) { effort = previous.effort; held.push("effort"); }
  }
  return { route: { model, effort }, reason: held.length ? "low-confidence" : "classified",
    support: { model: { main: mainSupport, expert: expertSupport }, effort: { low: lowSupport, ordinary: ordinarySupport, high: highSupport } },
    held: [...new Set(held)] };
}
