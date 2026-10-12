import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export interface Route { model: string; effort: string }
export const ROLES = ["fast", "balanced", "deep"] as const;
export type Role = typeof ROLES[number];
export interface SemanticConfig {
  mode: "shadow" | "auto";
  provider: "typesafe" | "vercel" | "kev";
  endpoint: string;
  apiKeyEnv?: string;
  model: string;
  roles: Record<Role, string>;
  timeoutMs: number;
  maxInputBytes: number;
  minConfidence: number;
}
export interface ExecutionCaptureConfig {
  directory: string;
  projects: { directory: string; paths: string[] }[];
}
export interface NativeReviewConfig extends Route {
  maxReviewsPerTask: number;
  timeoutMs: number;
  maxTokens: number;
  maxToolCalls: number;
}
export interface NativeRule extends Route { prefix: string }
export interface Config {
  version: 1;
  auth: "chatgpt" | "api-key" | "mock";
  upstream?: string;
  catalog?: string;
  defaultRoute: string;
  routes: Record<string, Route>;
  rules: { prefix: string; route: string }[];
  semantic?: SemanticConfig;
  capture?: { directory: string; execution?: ExecutionCaptureConfig };
  native?: { expertModel?: string; expertPolicy?: "constraints"; review?: NativeReviewConfig; rules?: NativeRule[] };
}
export const AUTO_MODEL = "fenjue-auto";
export const PROXY_HEADER = "x-fenjue-token";
const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const VERCEL_ENDPOINT = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validRoute(value: unknown): value is Route {
  return record(value) && typeof value.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$/.test(value.model) && value.model !== AUTO_MODEL &&
    typeof value.effort === "string" && ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "none"].includes(value.effort);
}
export function parseConfig(value: unknown): Config {
  if (!record(value) || value.version !== 1) throw new Error("配置 version 必须为 1");
  if (!["chatgpt", "api-key", "mock"].includes(String(value.auth))) throw new Error("auth 必须为 chatgpt、api-key 或 mock");
  if (!record(value.routes) || !Object.keys(value.routes).length) throw new Error("routes 不能为空");
  for (const [name, route] of Object.entries(value.routes)) {
    if (!validRoute(route)) {
      throw new Error(`路线 ${name} 必须提供真实 model 和有效 effort`);
    }
  }
  if (typeof value.defaultRoute !== "string" || !Object.hasOwn(value.routes, value.defaultRoute)) throw new Error("defaultRoute 不存在");
  const rules = value.rules ?? [];
  if (!Array.isArray(rules) || rules.some(r => !record(r) || typeof r.prefix !== "string" || !r.prefix.trim() || typeof r.route !== "string" || !Object.hasOwn(value.routes as object, r.route))) {
    throw new Error("rules 必须包含非空 prefix 和已有 route");
  }
  if (value.catalog !== undefined && typeof value.catalog !== "string") throw new Error("catalog 必须为文件路径");
  if (value.capture !== undefined && (!record(value.capture) || typeof value.capture.directory !== "string" || !value.capture.directory.trim())) {
    throw new Error("capture.directory 必须为本地采集目录；省略 capture 时不采集");
  }
  if (record(value.capture) && value.capture.execution !== undefined) {
    const e = value.capture.execution;
    if (!record(e) || typeof e.directory !== "string" || !e.directory.trim() || !Array.isArray(e.projects) || !e.projects.length ||
        e.projects.some(p => !record(p) || typeof p.directory !== "string" || !p.directory.trim() || !Array.isArray(p.paths) || !p.paths.length ||
          p.paths.some(path => typeof path !== "string" || !path.trim() || path === "." || path.startsWith("/") || path.split("/").includes("..")))) {
      throw new Error("capture.execution 需要 directory 和明确指定 directory/paths 的项目列表");
    }
  }
  if (value.native !== undefined && (!record(value.native) ||
      (value.native.expertModel !== undefined && (typeof value.native.expertModel !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$/.test(value.native.expertModel))))) {
    throw new Error("native.expertModel 必须为真实模型名；省略时只自动选择主模型的三档 effort");
  }
  let native = value.native;
  if (record(native) && native.rules !== undefined && (!Array.isArray(native.rules) || native.rules.some(r =>
    !record(r) || typeof r.prefix !== "string" || !r.prefix.trim() || !validRoute(r)))) {
    throw new Error("native.rules 需要非空 prefix、真实 model 和有效 effort");
  }
  if (record(native) && native.expertPolicy !== undefined &&
      (native.expertPolicy !== "constraints" || typeof native.expertModel !== "string")) {
    throw new Error("native.expertPolicy 仅支持候选 constraints，且需要 expertModel");
  }
  if (record(value.native) && value.native.review !== undefined) {
    const r = value.native.review;
    if (!record(r) || typeof r.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$/.test(r.model) ||
        !["low", "medium", "high"].includes(String(r.effort ?? "high"))) throw new Error("native.review 需要真实 model 和 low/medium/high effort");
    const review = { ...r, effort: r.effort ?? "high", maxReviewsPerTask: r.maxReviewsPerTask ?? 3,
      timeoutMs: r.timeoutMs ?? 120000, maxTokens: r.maxTokens ?? 12000, maxToolCalls: r.maxToolCalls ?? 20 };
    for (const [key, min, max] of [["maxReviewsPerTask", 1, 3], ["timeoutMs", 1000, 300000],
      ["maxTokens", 1, 100000], ["maxToolCalls", 1, 100]] as const) {
      if (!Number.isSafeInteger(review[key]) || Number(review[key]) < min || Number(review[key]) > max) throw new Error(`native.review.${key} 范围为 ${min}–${max}`);
    }
    native = { ...value.native, review };
  }
  let semantic: SemanticConfig | undefined;
  if (value.semantic !== undefined) {
    const s = value.semantic;
    if (!record(s) || !["shadow", "auto"].includes(String(s.mode))) throw new Error("semantic 必须指定 shadow/auto 模式");
    const provider = s.provider === undefined ? "typesafe" : s.provider;
    if (provider !== "typesafe" && provider !== "vercel" && provider !== "kev") throw new Error("semantic.provider 必须为 typesafe、vercel 或 kev");
    if (typeof s.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,120}$/.test(s.model)) throw new Error("semantic.model 必须为有效模型名");
    if (provider === "typesafe" && !/^jev-\d+\.\d+\.\d+$/.test(s.model)) {
      throw new Error("TypeSafe 必须使用固定 Jev 版本（例如 jev-1.13.0）");
    }
    const endpoint = s.endpoint ?? (provider === "typesafe" ? TYPESAFE_ENDPOINT : provider === "vercel" ? VERCEL_ENDPOINT : "http://127.0.0.1:8009/v1/systemone");
    if (typeof endpoint !== "string") throw new Error("semantic.endpoint 必须为完整 HTTP(S) 接口地址");
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error("semantic.endpoint 必须为完整 HTTP(S) 接口地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("semantic.endpoint 必须为 HTTP(S) 地址，不含凭据、查询参数或片段");
    }
    if (provider === "typesafe" && url.href !== TYPESAFE_ENDPOINT) throw new Error("TypeSafe 使用固定官方地址；自部署服务请选择 provider=kev");
    if (provider === "vercel" && url.href !== VERCEL_ENDPOINT) throw new Error("Vercel 使用固定官方 TypeSafe 兼容地址");
    if (s.apiKeyEnv !== undefined && (typeof s.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.apiKeyEnv))) {
      throw new Error("semantic.apiKeyEnv 必须为认证密钥的环境变量名");
    }
    const apiKeyEnv = s.apiKeyEnv ?? (provider === "typesafe" ? "TYPESAFE_API_KEY" : provider === "vercel" ? "AI_GATEWAY_API_KEY" : undefined);
    if (!record(s.roles) || ROLES.some(role => typeof (s.roles as Record<string, unknown>)[role] !== "string" ||
        !Object.hasOwn(value.routes as object, String((s.roles as Record<string, unknown>)[role])))) {
      throw new Error("semantic.roles 的 fast / balanced / deep 必须引用已有路线");
    }
    if (new Set(Object.values(s.roles)).size !== 3) throw new Error("三个角色应引用不同路线；路线可使用同一型号");
    const timeoutMs = s.timeoutMs ?? (provider === "typesafe" ? 3000 : 30000), maxInputBytes = s.maxInputBytes ?? 24000, minConfidence = s.minConfidence ?? 0.75;
    if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 120000 ||
        !Number.isSafeInteger(maxInputBytes) || Number(maxInputBytes) < 1024 || Number(maxInputBytes) > 24000 ||
        typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new Error("semantic 参数范围：timeoutMs 1–120000，maxInputBytes 1024–24000，minConfidence 0–1");
    }
    semantic = { ...s, provider, endpoint: url.href, apiKeyEnv, timeoutMs, maxInputBytes, minConfidence } as unknown as SemanticConfig;
  }
  if (value.auth === "mock") {
    const url = new URL(String(value.upstream));
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
      throw new Error("mock upstream 必须为本机回环 HTTP 地址");
    }
  } else if (value.upstream !== undefined) {
    throw new Error("真实认证使用固定 OpenAI 上游，不接受 upstream 覆盖");
  }
  return { ...value, native, rules, semantic } as unknown as Config;
}
export async function readConfig(path: string): Promise<Config> {
  const config = parseConfig(JSON.parse(await readFile(path, "utf8")));
  if (config.catalog) config.catalog = resolve(dirname(path), config.catalog);
  if (config.capture) config.capture.directory = resolve(dirname(path), config.capture.directory);
  if (config.capture?.execution) {
    config.capture.execution.directory = resolve(dirname(path), config.capture.execution.directory);
    for (const project of config.capture.execution.projects) project.directory = resolve(dirname(path), project.directory);
  }
  return config;
}
export function upstreamURL(config: Config): URL {
  return new URL(config.auth === "mock" ? config.upstream! :
    config.auth === "chatgpt" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1");
}
