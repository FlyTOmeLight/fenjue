import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config, readJSON, serve } from "../test/fixtures.js";
import type { Model } from "../src/catalog.js";
import { captureFrames, draftCase } from "../src/cases.js";

const exec = promisify(execFile);
const codex = process.env.FENJUE_CODEX_BIN ?? "codex";
const version = (await exec(codex, ["--version"])).stdout.trim();
const bundled = JSON.parse((await exec(codex, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024 })).stdout);
const template: Model = bundled.models.find((m: Model) => m.slug === "gpt-6.1-sol");
assert.ok(template, "This verification expects the gpt-6.1-sol contract in the bundled Codex catalog");
const temp = await mkdtemp(join(tmpdir(), "fenjue-verify-"));
const seen: { model: string; effort: string; path: string; outputs: string[] }[] = [];
let wantTool = false, sentTool = false, retryOnce = false;
function toolsOf(body: any): { name: string; namespace?: string; type: string; parameters?: any }[] {
  const tools = [...(body.tools ?? []), ...(body.input ?? []).filter((i: any) => i.type === "additional_tools").flatMap((i: any) => i.tools ?? [])];
  return tools.flatMap((t: any) => t.type === "namespace" ?
    (t.tools ?? []).map((inner: any) => ({ ...inner, namespace: t.name })) : [t]);
}
const upstream = await serve(async (req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/responses")) { res.writeHead(404); res.end(); return; }
  const body = await readJSON(req);
  const outputs: string[] = (body.input ?? []).filter((i: any) => i.type === "function_call_output" || i.type === "custom_tool_call_output").map((i: any) => JSON.stringify(i.output));
  seen.push({ model: body.model, effort: body.reasoning?.effort, path: req.url, outputs });
  if (retryOnce) { retryOnce = false; res.writeHead(503); res.end('{"error":{"message":"fixture retry","type":"server_error"}}'); return; }
  let item: any;
  if (wantTool && !sentTool) {
    const tools = toolsOf(body);
    const tool = tools.find(t => t.name === "exec_command") ?? tools.find(t => t.name === "shell_command") ?? tools.find(t => t.name === "exec");
    assert.ok(tool, "No fixture-supported tool: " + JSON.stringify({ tools: tools.map(t => ({name:t.name,type:t.type,namespace:t.namespace})), input: (body.input ?? []).map((i: any) => ({type:i.type, keys:Object.keys(i)})) }));
    const args = tool.name === "shell_command" ? { command: "printf FENJUE_TOOL_OK" } :
      tool.name === "exec" ? { code: 'console.log("FENJUE_TOOL_OK")' } : { cmd: "printf FENJUE_TOOL_OK", max_output_tokens: 1000 };
    item = tool.type === "custom" ?
      { type: "custom_tool_call", id: "fc_fixture", call_id: "call_fixture", name: tool.name, namespace: tool.namespace, input: 'text("FENJUE_TOOL_OK")' } :
      { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: tool.name, namespace: tool.namespace, arguments: JSON.stringify(args) };
    sentTool = true;
  } else {
    if (wantTool) assert.ok(outputs.some(s => s.includes("FENJUE_TOOL_OK")), "Native tool did not return the marker: " + outputs.join("\n"));
    item = { type: "message", id: "msg_fixture", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "模拟验证通过：中文🙂", annotations: [] }] };
  }
  const response = { id: "resp_" + seen.length, object: "response", status: "completed", model: body.model, output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(item.type === "message" ? { content: [] } : {}) } },
    ...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text }] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  const data = Buffer.from(events.map((e, sequence_number) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number })}\n\n`).join(""));
  res.writeHead(200, { "content-type": "text/event-stream", "openai-model": body.model });
  const cut = data.indexOf(Buffer.from("中"));
  if (cut >= 0) { res.write(data.subarray(0, cut + 1)); await delay(5); res.end(data.subarray(cut + 1)); }
  else res.end(data);
});
try {
  const models = ["fixture-fast", "fixture-deep"].map(slug => ({ ...template, slug }));
  const catalogPath = join(temp, "models.json");
  await writeFile(catalogPath, JSON.stringify({ models }), { mode: 0o600 });
  const settings = { ...config(upstream.url), catalog: catalogPath, capture: { directory: join(temp, "daily") } };
  const configPath = join(temp, "config.json");
  await writeFile(configPath, JSON.stringify(settings), { mode: 0o600 });
  const cli = resolve("dist/src/cli.js");
  const common = [
    "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json", "--color", "never", "-C", temp, "--sandbox", "read-only",
    "-c", `sqlite_home=${JSON.stringify(temp)}`, "-c", `log_dir=${JSON.stringify(temp)}`,
    "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "features.remote_plugin=false",
    "-c", "features.hooks=false", "-c", "features.memories=false", "-c", "features.shell_snapshot=false",
    "-c", "features.multi_agent=false", "-c", "features.skip_host_skill_discovery=true",
    "-c", "model_providers.fenjue.request_max_retries=1", "-c", "model_providers.fenjue.stream_max_retries=0",
    "-c", "features.unbounded_connection_retries=false",
  ];
  async function run(prompt: string): Promise<string> {
    return new Promise<string>((resolveRun, reject) => {
      const child = spawn(process.execPath, [cli, "codex", "--config", configPath, "--log-dir", join(temp, "logs"), "--", ...common, prompt], {
        env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", FENJUE_CODEX_BIN: codex }, stdio: ["ignore","pipe","pipe"],
      });
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 30_000);
      child.once("error", e => { clearTimeout(timer); reject(e); });
      child.once("exit", code => {
        clearTimeout(timer);
        if (timedOut || code !== 0) reject(new Error(`Codex verification failed (exit ${code}, timeout ${timedOut})\n${stderr.slice(-6000)}\n${stdout.slice(-2000)}`));
        else resolveRun(stdout);
      });
    });
  }
  retryOnce = true;
  const fast = await run("只输出本地模拟验证结果");
  assert.equal(fast.includes("\x1b"), false, "Non-TTY JSON stdout must not contain title escapes");
  for (const line of fast.trim().split("\n")) JSON.parse(line);
  assert.ok(fast.includes("模拟验证通过：中文🙂"), fast);
  assert.equal(fast.includes("model rerouted"), false, "Expected alias must not trigger a false upstream reroute warning");
  assert.ok(seen.length >= 2, "Expected native request retry after mock 503");
  assert.ok(seen.every(s => s.model === "fixture-fast" && s.effort === "low"));
  const before = seen.length;
  wantTool = true;
  const deep = await run("[deep] 调用一个本地工具后输出验证结果");
  assert.ok(deep.includes("模拟验证通过：中文🙂"), deep);
  assert.equal(deep.includes("model rerouted"), false);
  assert.ok(seen.length >= before + 2, "Expected tool continuation request");
  assert.ok(seen.slice(before).every(s => s.model === "fixture-deep" && s.effort === "high"));
  const logs = await Promise.all((await readdir(join(temp, "logs"))).map(f => readFile(join(temp, "logs", f), "utf8")));
  const receipts = logs.flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
  assert.ok(receipts.some(e => e.reason === "reused"), "Native retry was not recognized");
  const captures = await readdir(join(temp, "daily"));
  assert.equal(captures.length, 2);
  let capturedTurns = 0, capturedTool = false;
  for (const name of captures) {
    const file = join(temp, "daily", name), frames = await captureFrames(file);
    assert.ok(frames.length > 0);
    capturedTool ||= frames.some(f => f.items.some(i => i.kind === "evidence" && i.text.includes("FENJUE_TOOL_OK")));
    for (const thread of new Set(frames.map(f => f.thread))) {
      const draft = await draftCase(file, thread); capturedTurns += draft.case.turns.length;
      assert.equal(draft.review.approved, false);
    }
  }
  assert.equal(capturedTurns, 2, "Retries and tool continuations must not create duplicate user cases");
  assert.ok(capturedTool, "Capture must retain the actual native tool result");
  console.log(JSON.stringify({ codex: version, template: template.slug, requests: seen.length,
    checks: ["native CLI launcher", "model + effort rewrite", "503 retry", "Chinese SSE", "native tool execution + continuation", "route receipts", "daily capture + blind case draft", "clean JSON stdout", "clean exit"],
    realModelCalls: 0 }, null, 2));
} catch (error) {
  for (const failure of upstream.errors) console.error("Fixture upstream:", failure.message);
  throw error;
} finally {
  await upstream.close();
  await rm(temp, { recursive: true, force: true });
}
