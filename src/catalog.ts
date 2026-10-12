import { isDeepStrictEqual } from "node:util";
import { AUTO_MODEL, ROLES, record, type Config } from "./config.js";

export type Model = Record<string, unknown> & { slug: string };
export interface Catalog { models: Model[] }
// Presentation fields do not change the request contract. Everything else, including
// unknown future fields, must match until a separate compatibility evaluation exists.
const presentation = new Set([
  "slug", "display_name", "description", "visibility", "priority", "upgrade", "upgrade_info",
  "availability_nux", "available_access_programs", "supported_in_api",
  "default_reasoning_level", "supported_reasoning_levels",
  "context_window", "max_context_window", "auto_compact_token_limit",
]);
function contract(model: Model): Record<string, unknown> {
  return Object.fromEntries(Object.entries(model).filter(([key]) => !presentation.has(key)));
}
function efforts(model: Model): string[] {
  const entries = model.supported_reasoning_levels;
  return Array.isArray(entries) ? entries.filter(record).map(e => e.effort).filter((x): x is string => typeof x === "string") : [];
}
export function buildCatalog(value: unknown, config: Config): Catalog {
  if (!record(value) || !Array.isArray(value.models) || !value.models.every(m => record(m) && typeof m.slug === "string")) {
    throw new Error("Codex 模型目录必须包含 models 数组");
  }
  const originals = value.models as Model[];
  const selected = Object.values(config.routes).map(route => {
    const model = originals.find(m => m.slug === route.model);
    if (!model) throw new Error(`目录中找不到 ${route.model}`);
    if (config.auth === "api-key" && model.supported_in_api === false) throw new Error(`${route.model} 未在目录中声明 API 支持`);
    if (!efforts(model).includes(route.effort)) throw new Error(`${route.model} 不支持 effort=${route.effort}`);
    return model;
  });
  const base = originals.find(m => m.slug === config.routes[config.defaultRoute]!.model)!;
  for (const model of selected) {
    const a = contract(base), b = contract(model);
    const differences = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !isDeepStrictEqual(a[k], b[k]));
    if (differences.length) throw new Error(`${base.slug} 与 ${model.slug} 的请求契约不同：${differences.join(", ")}。首版拒绝直接切换。`);
  }
  const commonEfforts = efforts(base).filter(e => selected.every(m => efforts(m).includes(e)));
  if (!commonEfforts.length) throw new Error("候选模型没有共同的 effort");
  if (config.semantic) {
    const roleEfforts = ROLES.map(role => config.routes[config.semantic!.roles[role]]!.effort);
    const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    if (roleEfforts.some((e, i) => i > 0 && order.indexOf(e) < order.indexOf(roleEfforts[i - 1]!))) throw new Error("角色 effort 必须按 fast / balanced / deep 递增或相等");
    // Independent model/effort selection and retained explicit efforts must all work.
    for (const model of selected) for (const route of Object.values(config.routes)) {
      if (!efforts(model).includes(route.effort)) throw new Error(`${model.slug} 不支持自动组合 effort=${route.effort}`);
    }
  }
  const auto: Model = {
    ...base, slug: AUTO_MODEL, display_name: `Fenjue Auto (${config.semantic?.mode ?? "fixed rules"})`,
    description: config.semantic ? `${config.semantic.provider} task routing: ${config.semantic.mode}` : "Deterministic routing; semantic classification is not enabled.",
    visibility: "list", priority: 0, upgrade: null,
    default_reasoning_level: commonEfforts.includes(config.routes[config.defaultRoute]!.effort) ? config.routes[config.defaultRoute]!.effort : commonEfforts[0],
    supported_reasoning_levels: (base.supported_reasoning_levels as Record<string, unknown>[]).filter(e => commonEfforts.includes(String(e.effort))),
  };
  for (const key of ["context_window", "max_context_window", "auto_compact_token_limit"]) {
    const sizes = selected.map(m => m[key]);
    if (sizes.every((v): v is number => typeof v === "number")) auto[key] = Math.min(...sizes);
    else delete auto[key];
  }
  return { models: [auto, ...originals.filter(m => m.slug !== AUTO_MODEL)] };
}
