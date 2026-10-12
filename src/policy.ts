import { ROLES, type Config, type Route, type Role } from "./config.js";
import type { Classification } from "./classification.js";

export interface Selection extends Route { route: string }
// Any one of these signals is sufficient for deep/high. Unrelated questions
// must not veto that decision. For ordinary work, sufficient vs missing does
// not change the route: retrieving inputs or clarifying them is not diagnosis.
export function decisionConfidence(result: Classification): number {
  const f = result.features, q = result.questionScores;
  const high = [
    ["architecture", "diagnosis"].includes(f.reasoning) ? q.reasoning.confidence : 0,
    f.uncertainty === "unknown_cause" ? q.uncertainty.confidence : 0,
    f.consequence === "sensitive" ? q.consequence.confidence : 0,
  ];
  if (["architecture", "diagnosis"].includes(f.reasoning) || f.uncertainty === "unknown_cause" || f.consequence === "sensitive") return Math.max(...high);
  const nonFaultSupport = 1 - q.uncertainty.probabilities.unknown_cause;
  return Math.min(q.scope.confidence, q.reasoning.confidence, nonFaultSupport, q.consequence.confidence);
}
export function confidentNewTask(result: Classification, threshold: number): boolean {
  return result.features.relation === "new" && result.questionScores.relation.confidence >= threshold;
}
export function policySelection(config: Config, result: Classification, previous?: Selection,
  newTask = confidentNewTask(result, config.semantic!.minConfidence)): Selection {
  const s = config.semantic!, f = result.features;
  if (!previous && !newTask) previous = { ...config.routes[s.roles.balanced]!, route: s.roles.balanced };
  let model: Role = f.scope === "cross_system" || f.reasoning === "architecture" || f.reasoning === "diagnosis" ||
    f.uncertainty === "unknown_cause" || f.consequence === "sensitive" ? "deep" :
    f.scope === "local" && f.reasoning === "mechanical" && f.consequence === "reversible" ? "fast" : "balanced";
  let effort: Role = ["architecture", "diagnosis"].includes(f.reasoning) || f.uncertainty === "unknown_cause" || f.consequence === "sensitive" ? "deep" :
    f.reasoning === "mechanical" && f.consequence === "reversible" ? "fast" : "balanced";
  const roles = ROLES.map(role => s.roles[role]);
  if (previous && !newTask) {
    const previousRole = roles.indexOf(previous.route);
    // Explicit routes outside the semantic roles remain in force until a new task.
    if (previousRole < 0) return previous;
    model = ROLES[Math.max(ROLES.indexOf(model), previousRole)]!;
    const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    if (effortOrder.indexOf(previous.effort) > effortOrder.indexOf(config.routes[s.roles[effort]]!.effort)) {
      return { model: config.routes[s.roles[model]]!.model, route: s.roles[model], effort: previous.effort };
    }
  }
  return { model: config.routes[s.roles[model]]!.model, route: s.roles[model], effort: config.routes[s.roles[effort]]!.effort };
}
