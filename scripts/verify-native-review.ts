import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readJSON, serve, classification } from "../test/fixtures.js";
import { parseConfig } from "../src/config.js";
import { NativeRecords } from "../src/native-records.js";
import { nativeArguments } from "../src/native-launcher.js";
import { startNativeGateway } from "../src/native-gateway.js";
import { EvaluationClient } from "./native-evaluation-client.js";
import { iterationReport, observedTasks } from "../src/feedback.js";

// Installed Codex + production gateway, backed only by a local model fixture.
const root = await mkdtemp(join(tmpdir(), "fenjue-native-review-"));
const repository = process.cwd();
const codex = process.env.FENJUE_CODEX_BIN ?? "codex";
let gateway: Awaited<ReturnType<typeof startNativeGateway>> | undefined;
let upstream: Awaited<ReturnType<typeof serve>> | undefined, client: EvaluationClient | undefined;
let mainStep = 0, expertStep = 0;
const seen: any[] = [], events: any[] = [];
const terminal = process.argv.includes("--terminal");
try {
  await writeFile(join(root, "result.txt"), "before\n");
  const home = join(root, "home"); await mkdir(home);
  const mcpFixture = join(root, "mcp.mjs");
  await writeFile(mcpFixture, `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'review_boundary',version:'1'}}:
 m.method==='tools/list'?{tools:[{name:'write_file',description:'Fixture write tool',inputSchema:{type:'object'}}]}:
 m.method==='tools/call'?{content:[{type:'text',text:'Forbidden fixture call'}],isError:true}:{};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`);
  upstream = await serve(async (req, res) => {
    const body = await readJSON(req); seen.push({ model: body.model, effort: body.reasoning?.effort,
      outputs: (body.input ?? []).filter((i: any) => i.type.endsWith("call_output")) });
    const expert = body.model === "gpt-6-astra";
    const tools = [...(body.tools ?? []), ...(body.input ?? []).filter((i: any) => i.type === "additional_tools").flatMap((i: any) => i.tools ?? [])]
      .flatMap((t: any) => t.type === "namespace" ? (t.tools ?? []).map((inner: any) => ({ ...inner, namespace: t.name })) : [t]);
    if (expert) assert.doesNotMatch(JSON.stringify(tools), /review_boundary/, "reviewer inherited an external MCP write tool");
    const command = (cmd: string) => {
      const tool = tools.find(t => t.name === "exec_command") ?? tools.find(t => t.name === "exec"); assert.ok(tool);
      const args = { cmd, max_output_tokens: 1000 };
      return { type: tool.type === "custom" ? "custom_tool_call" : "function_call", id: "item-" + seen.length,
        call_id: "call-" + seen.length, name: tool.name, namespace: tool.namespace,
        ...(tool.type === "custom" ? { input: `text(await tools.exec_command(${JSON.stringify(args)}))` } : { arguments: JSON.stringify(args) }) };
    };
    const patch = (from: string, to: string) => {
      const exec = tools.find(t => t.name === "exec" && t.type === "custom");
      const tool = exec ?? tools.find(t => t.name === "apply_patch"); assert.ok(tool);
      const input = `*** Begin Patch\n*** Update File: ${join(root, "result.txt")}\n@@\n-${from}\n+${to}\n*** End Patch`;
      return { type: "custom_tool_call", id: "item-" + seen.length, call_id: "call-" + seen.length, name: tool.name, namespace: tool.namespace,
        input: exec ? `text(await tools.apply_patch(${JSON.stringify(input)}))` : input };
    };
    let item: any;
    const structured = body.text?.format?.type === "json_schema";
    if (structured) item = { type: "message", id: "title-" + seen.length, role: "assistant", content: [{ type: "output_text",
      text: JSON.stringify(Object.fromEntries(Object.keys(body.text.format.schema?.properties ?? {}).map(k => [k, "Review fixture"]))), annotations: [] }] };
    else if (expert && ++expertStep === 1) item = command("printf UNAUTHORIZED > result.txt");
    else if (!expert && ++mainStep === 1) item = command("printf 'AssertionError: wrong order\\n'; exit 1");
    else if (!expert && mainStep === 2) item = patch("before", "candidate");
    else if (!expert && mainStep === 3) item = command("printf 'AssertionError: wrong order\\n'; exit 1");
    else if (!expert && mainStep === 5) item = patch("candidate", "fixed");
    else if (!expert && mainStep === 6) item = command("test \"$(cat result.txt)\" = fixed");
    else {
      if (expert) {
        assert.equal(await readFile(join(root, "result.txt"), "utf8"), "candidate\n", "read-only reviewer changed the workspace");
        assert.match(JSON.stringify(body.input), /[Pp]ermission|[Oo]peration not permitted|[Rr]ead.only/);
      }
      item = { type: "message", id: "answer-" + seen.length, role: "assistant", phase: "final_answer", content: [
        { type: "output_text", text: expert ? "REVIEW_ADVICE: result.txt should contain fixed. Verify the requirement before editing." : mainStep < 5 ? "MAIN_REQUIRES_REVIEW" : mainStep > 7 ? "AFTER_AUTO_REVIEW" : "AUTO_REVIEW_FIXED", annotations: [] }] };
    }
    const response = { id: "response-" + seen.length, object: "response", status: "completed", model: body.model,
      output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    const messages = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, ...(item.type === "message" ? { content: [] } : {}) } },
      ...(item.type === "message" ? [{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text }] : []),
      { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(messages.map((m, sequence_number) => `event: ${m.type}\ndata: ${JSON.stringify({ ...m, sequence_number })}\n\n`).join(""));
  });
  const base = JSON.parse(await readFile("examples/native-balanced.json", "utf8"));
  const config = parseConfig({ ...base, auth: "mock", upstream: upstream.url, semantic: { ...base.semantic, mode: "auto" },
    native: { ...base.native, review: { model: "gpt-6-astra", timeoutMs: 30000 } } });
  const settings = { sqlite_home: home, log_dir: home, "features.apps": false, "features.plugins": false,
    "mcp_servers.review_boundary.command": process.execPath, "mcp_servers.review_boundary.args": [mcpFixture],
    "features.remote_plugin": false, "features.hooks": false, "features.memories": false, "features.multi_agent": false,
    "features.shell_snapshot": false, "features.skip_host_skill_discovery": true, "features.reasoning_effort_override": false };
  const args = nativeArguments(config, Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`])).server;
  const records = new NativeRecords(root, join(root, "daily"), [], message => assert.fail(message));
  process.chdir(root);
  gateway = await startNativeGateway({ socket: join(root, "app.sock"), executable: codex, serverArgs: args,
    env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", CODEX_HOME: home, FENJUE_NATIVE_FIXTURE_KEY: "local-fixture-only" },
    config, records, classify: async () => classification(), onEvent: e => events.push(e), onFailure: error => { throw error; } });
  let terminalResult: Promise<{ stdout: string; stderr: string }> | undefined;
  if (terminal) {
    terminalResult = promisify(execFile)("python3", [join(repository, "scripts/native-review-terminal.py"), codex, join(root, "app.sock"), root, home], { timeout: 60000 });
    terminalResult.catch(() => {});
  } else {
    client = new EvaluationClient(join(root, "app.sock"), () => {}); await client.open();
    const started = await client.request("thread/start", { threadSource: "user", cwd: root, sandbox: "workspace-write", approvalPolicy: "never", model: "gpt-6.1-sol" });
    await client.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Fix result.txt to contain fixed and test the result." }] });
  }
  const deadline = Date.now() + 30000;
  while (!events.some(e => e.type === "completed" && e.turnId !== events.find(e => e.type === "accepted")?.turnId)) {
    if (Date.now() >= deadline) throw new Error("Automatic review did not complete: " + JSON.stringify({ seen,
      items: client?.messages.filter(m => m.method === "item/completed").map(m => m.params.item), events }));
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(await readFile(join(root, "result.txt"), "utf8"), "fixed\n");
  assert.equal(events.filter(e => e.type === "review-started").length, 1);
  assert.equal(events.filter(e => e.type === "accepted" && e.origin === "architect-revision").length, 1);
  if (client) {
    assert.equal(client.messages.some(m => m.params?.item?.text?.includes("REVIEW_ADVICE:")), false);
    assert.ok(client.messages.some(m => m.params?.item?.text === "AUTO_REVIEW_FIXED"));
    const expertId = events.find(e => e.type === "review-finished")?.reviewThreadId;
    assert.equal(client.messages.some(m => m.params?.threadId === expertId || m.params?.thread?.id === expertId), false);
    const inventory = await client.request("mcpServerStatus/list", { threadId: events.find(e => e.type === "accepted")!.threadId });
    assert.ok(inventory.data.find((s: any) => s.name === "review_boundary")?.tools.write_file, "main thread must retain its MCP tool");
  }
  const revision = events.find(e => e.type === "accepted" && e.origin === "architect-revision");
  assert.equal(revision.taskId, events.find(e => e.type === "accepted")!.taskId);
  if (terminalResult) console.log((await terminalResult).stdout.trim());
  assert.deepEqual(upstream.errors, []);
  const report = iterationReport(await observedTasks(root));
  assert.equal(report.summary.reviews, 1); assert.equal(report.summary.automaticRevisions, 1);
  const directory = resolve(repository, ".fenjue/verification", (terminal ? "automatic-review-terminal-" : "automatic-review-") + Date.now()); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "report.json"), JSON.stringify({ version: (await promisify(execFile)(codex, ["--version"])).stdout.trim(),
    checks: ["actual read-only write rejected", "external MCP tools excluded from reviewer", "private expert messages hidden", "automatic main revision completed", "original task identity retained", "expert usage reported"], seen, report }, null, 2));
  console.log(JSON.stringify({ passed: true, localModelRequests: seen.length, report: join(directory, "report.json") }));
} finally {
  client?.close(); await gateway?.close(); await upstream?.close(); process.chdir(repository); await rm(root, { recursive: true, force: true });
}
