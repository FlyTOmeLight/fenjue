import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { type Config, AUTO_MODEL, parseConfig } from "../src/config.js";
import { buildCatalog, type Model } from "../src/catalog.js";
import { QUESTIONS, type Classification, type Features, type QuestionScores } from "../src/classification.js";

export function config(upstream: string): Config {
  return { version: 1, auth: "mock", upstream, defaultRoute: "fast",
    routes: { fast: { model: "fixture-fast", effort: "low" }, deep: { model: "fixture-deep", effort: "high" } },
    rules: [{ prefix: "[deep]", route: "deep" }] };
}
export function models(): { models: Model[] } {
  return { models: ["fixture-fast","fixture-deep"].map(slug => ({
    slug, display_name: slug, description: "Local test model", base_instructions: "Test instructions",
    default_reasoning_level: "low", supported_reasoning_levels: ["low", "medium", "high"].map(effort => ({ effort, description: "" })),
    context_window: 100_000, shell_type: "unified_exec",
  })) };
}
export function catalog(c: Config) { return buildCatalog(models(), c); }
export function semanticConfig(mode: "auto" | "shadow" = "auto", upstream = "http://127.0.0.1:1"): Config {
  const c = config(upstream);
  return parseConfig({ ...c, defaultRoute: "balanced", routes: { ...c.routes, balanced: { model: "fixture-fast", effort: "medium" } },
    semantic: { mode, model: "jev-1.13.0", roles: { fast: "fast", balanced: "balanced", deep: "deep" } } });
}
export function kevConfig(endpoint = "http://127.0.0.1:8009/v1/systemone", mode: "auto" | "shadow" = "auto", upstream = "http://127.0.0.1:1"): Config {
  const c = semanticConfig(mode, upstream);
  return parseConfig({ ...c, semantic: { ...c.semantic, provider: "kev", endpoint, apiKeyEnv: undefined, model: "kev-latest", timeoutMs: 30000 } });
}
export function classification(features: Partial<Features> = {}, confidence = 0.95): Classification {
  const selected: Features = { relation: "new", scope: "local", reasoning: "mechanical", uncertainty: "sufficient", consequence: "reversible", ...features };
  const questionScores = Object.fromEntries(Object.entries(selected).map(([key, choice]) => [key, {
    confidence, probabilities: Object.fromEntries(Object.keys(QUESTIONS[key as keyof Features].criteria).map(option => [option, option === choice ? 1 : 0])),
  }])) as QuestionScores;
  return { model: "jev-1.13.0", inputTokens: 100, confidence, features: selected, questionScores };
}
export function jevResponse(result = classification()) {
  return { model: result.model, usage: { input_tokens: result.inputTokens, output_tokens: 0 },
    answers: Object.fromEntries(Object.entries(result.features).map(([key, choice]) => [key, {
      type: "choice", choice, ...result.questionScores[key as keyof Features],
    }])) };
}
export function request(text = "你好", key = "thread-1"): Record<string, unknown> {
  return { model: AUTO_MODEL, prompt_cache_key: key, stream: true, reasoning: { effort: "high", summary: "auto" },
    input: [{ role: "user", content: [{ type: "input_text", text }] }], tools: [{ type: "function", name: "example", parameters: { type: "object" } }] };
}
export async function readJSON(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const errors: Error[] = [];
  const server = http.createServer((req, res) => { Promise.resolve(handler(req, res)).catch(e => { errors.push(e); res.destroy(e); }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, errors, async close() {
    await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); });
  } };
}
