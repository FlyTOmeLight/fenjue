import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/catalog.js";
import { parseConfig } from "../src/config.js";
import { codexOverrides } from "../src/launcher.js";
import { config, models, semanticConfig, kevConfig } from "./fixtures.js";

test("catalog refuses different prompts/tool contracts, missing models, invalid efforts", () => {
  const c = config("http://127.0.0.1:1234");
  for (const field of ["base_instructions", "shell_type", "future_capability"]) {
    const input = models(); input.models[1]![field] = "different";
    assert.throws(() => buildCatalog(input, c), /请求契约不同/);
  }
  assert.throws(() => buildCatalog({ models: [] }, c), /找不到/);
  const invalid = config("http://127.0.0.1:1234"); invalid.routes.deep!.effort = "ultra";
  assert.throws(() => buildCatalog(models(), invalid), /不支持 effort/);
});
test("virtual catalog uses common context capacity and leaves source metadata unchanged", () => {
  const input = models(); input.models[1]!.context_window = 1000;
  const result = buildCatalog(input, config("http://127.0.0.1:1234"));
  assert.equal(result.models[0]!.context_window, 1000);
  assert.equal(input.models[0]!.slug, "fixture-fast");
});
test("configuration does not send real authentication to an arbitrary upstream", () => {
  assert.throws(() => parseConfig({ ...config("https://example.com"), auth: "chatgpt" }), /不接受 upstream/);
  assert.throws(() => parseConfig(config("http://example.com")), /回环/);
  assert.throws(() => parseConfig({ ...config("http://127.0.0.1:1"), defaultRoute: "missing" }), /不存在/);
});
test("launcher selects SSE, native OpenAI authentication or API key without shell command building", () => {
  for (const auth of ["chatgpt", "api-key", "mock"] as const) {
    const overrides = codexOverrides({ ...config("http://127.0.0.1:1"), auth }, "http://127.0.0.1:2", "/tmp/a space/models.json");
    assert.ok(overrides.includes('model_providers.fenjue.supports_websockets=false'));
    assert.ok(overrides.includes(`model_providers.fenjue.requires_openai_auth=${auth === "chatgpt"}`));
    assert.ok(overrides.includes('model_catalog_json="/tmp/a space/models.json"'));
  }
});

test("semantic config pins Jev and validates independently combined model/effort pairs", () => {
  const c = semanticConfig();
  for (const patch of [{ model: "jev-latest" }, { minConfidence: 2 }, { timeoutMs: 0 },
    { roles: { fast: "fast", balanced: "missing", deep: "deep" } }]) {
    assert.throws(() => parseConfig({ ...c, semantic: { ...c.semantic, ...patch } }));
  }
  const input = models();
  input.models[1]!.supported_reasoning_levels = [{ effort: "high", description: "" }];
  assert.throws(() => buildCatalog(input, c), /不支持自动组合/);
  const descending = semanticConfig(); descending.routes.fast!.effort = "high";
  assert.throws(() => buildCatalog(models(), descending), /递增/);
  assert.match(String(buildCatalog(models(), c).models[0]!.display_name), /auto/);
});

test("Kev has its own endpoint and optional credentials; existing TypeSafe configs keep fixed official defaults", () => {
  const official = semanticConfig();
  assert.equal(official.semantic!.provider, "typesafe");
  assert.equal(official.semantic!.endpoint, "https://api.typesafe.ai/v1/systemone");
  assert.equal(official.semantic!.apiKeyEnv, "TYPESAFE_API_KEY");
  assert.equal(official.semantic!.timeoutMs, 3000);
  const c = kevConfig();
  const local = parseConfig({ ...c, semantic: { ...c.semantic, endpoint: undefined, timeoutMs: undefined } }).semantic!;
  assert.equal(local.endpoint, "http://127.0.0.1:8009/v1/systemone");
  assert.equal(local.apiKeyEnv, undefined); assert.equal(local.timeoutMs, 30000);
  const remote = parseConfig({ ...c, semantic: { ...c.semantic, endpoint: "https://my-kev.example/gateway/v1/systemone", apiKeyEnv: "KEV_API_KEY", model: "my-checkpoint@v2", timeoutMs: 60000 } });
  assert.equal(remote.semantic!.apiKeyEnv, "KEV_API_KEY");
  assert.equal(remote.semantic!.model, "my-checkpoint@v2");
  for (const patch of [{ provider: "unknown" }, { endpoint: "file:///tmp/kev" }, { endpoint: "http://user:secret@localhost:8009/v1/systemone" },
    { endpoint: "http://localhost:8009/v1/systemone?key=secret" }, { endpoint: "not-a-url" }, { apiKeyEnv: "Bearer key" }, { timeoutMs: 120001 }]) {
    assert.throws(() => parseConfig({ ...c, semantic: { ...c.semantic, ...patch } }));
  }
  assert.throws(() => parseConfig({ ...official, semantic: { ...official.semantic, endpoint: local.endpoint } }), /固定官方地址/);
});

test("Vercel uses Gateway credentials at its fixed TypeSafe-compatible endpoint", () => {
  const c = semanticConfig();
  const input = { ...c, semantic: { ...c.semantic, provider: "vercel", endpoint: undefined, apiKeyEnv: undefined, timeoutMs: undefined, model: "typesafe-ai/jev" } };
  const s = parseConfig(input).semantic!;
  assert.equal(s.endpoint, "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
  assert.equal(s.apiKeyEnv, "AI_GATEWAY_API_KEY"); assert.equal(s.timeoutMs, 30000);
  assert.throws(() => parseConfig({ ...input, semantic: { ...input.semantic, endpoint: "https://example.com/v1/systemone" } }), /固定官方/);
});
