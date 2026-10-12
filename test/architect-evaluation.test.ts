import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { serve, jevResponse } from "./fixtures.js";

test("execution CLI pairs isolated read-only reviewers and counts all work without leaking advice into the answer", async t => {
  const root = await mkdtemp(join(tmpdir(), "fenjue-architect-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const classifier = await serve(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(jevResponse()));
  });
  t.after(() => classifier.close());
  const suite = join(root, "suite"), snapshot = join(suite, "snapshot"), output = join(root, "output");
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, "result.txt"), "broken");
  await writeFile(join(suite, "verify.mjs"), `import {readFileSync} from 'node:fs';
const passed=readFileSync(process.env.FENJUE_WORKSPACE+'/result.txt','utf8')==='fixed';
console.log(JSON.stringify({passed}));process.exitCode=passed?0:1;`);
  await writeFile(join(suite, "suite.json"), JSON.stringify({ version: 1, baseline: "baseline", strategies: [
    { id: "baseline", kind: "sol-auto" },
    { id: "self-review", kind: "advisor-auto", advisorRoute: { model: "gpt-6.1-sol", effort: "high" } },
    { id: "architect", kind: "advisor-auto", advisorRoute: { model: "gpt-6-astra", effort: "high" } },
  ], tasks: [{ id: "repair", category: "diagnosis", group: "project", origin: "synthetic", split: "calibration", snapshot: "snapshot",
    prompts: ["Fix result.txt"], reviewCheckpoints: ["plan", "final"], acceptance: { argv: [process.execPath, "{suite}/verify.mjs"], timeoutMs: 2000 },
    limits: { wallMs: 10000, toolCalls: 30, tokens: 5000 } }] }));
  const config = JSON.parse(await readFile(resolve("examples/native-balanced.json"), "utf8"));
  config.semantic = { provider: "kev", endpoint: classifier.url + "/v1/systemone", model: "kev-latest", mode: "auto",
    roles: { fast: "fast", balanced: "balanced", deep: "deep" }, minConfidence: 0.75 };
  const configFile = join(root, "config.json"); await writeFile(configFile, JSON.stringify(config));
  const fixture = join(root, "codex-fixture"), traceFile = join(root, "trace.jsonl");
  await writeFile(fixture, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli fixture');process.exit(0)}
if(args[0]==='debug'){console.log(JSON.stringify({models:['gpt-6.1-sol','gpt-6-astra'].map(slug=>({slug,supported_reasoning_levels:['low','medium','high'].map(effort=>({effort}))}))}));process.exit(0)}
const send=v=>console.log(JSON.stringify(v));let next=0,turn=0;const threads=new Map();
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params??{};
 if(m.method==='initialize'){send({id:m.id,result:{}});return}
 if(m.method==='thread/start'){
  const id='thread-'+(++next);threads.set(id,{cwd:p.cwd,architect:!!p.ephemeral,tokens:0});
  appendFileSync(process.env.FENJUE_FIXTURE_TRACE,JSON.stringify({method:m.method,params:p})+'\\n');
  send({id:m.id,result:{thread:{id,threadSource:p.threadSource,ephemeral:p.ephemeral,turns:[]},model:p.model,reasoningEffort:p.config.model_reasoning_effort,cwd:p.cwd}});return
 }
 if(m.method==='turn/start'){
  const thread=threads.get(p.threadId),id='turn-'+(++turn),readOnly=p.sandboxPolicy.type==='readOnly';
  if(thread.architect&&!readOnly)throw new Error('reviewer must be read-only');
  appendFileSync(process.env.FENJUE_FIXTURE_TRACE,JSON.stringify({method:m.method,params:p,architect:thread.architect})+'\\n');
  if(!thread.architect&&!readOnly)writeFileSync(thread.cwd+'/result.txt','fixed');
  const item={id:'answer-'+turn,type:'agentMessage',phase:'final_answer',text:thread.architect?'ARCHITECT_ADVICE':readOnly?'IMPLEMENTATION_PLAN':'DELIVERY_RESULT'};
  send({id:m.id,result:{turn:{id,status:'inProgress'}}});
  send({method:'turn/started',params:{threadId:p.threadId,turn:{id}}});
  thread.tokens+=thread.architect?20:100;
  if(!(thread.architect&&process.env.FENJUE_FIXTURE_SKIP_EXPERT_USAGE))send({method:'thread/tokenUsage/updated',params:{threadId:p.threadId,turnId:id,tokenUsage:{total:{totalTokens:thread.tokens,cachedInputTokens:0},last:{totalTokens:thread.architect?20:100}}}});
  send({method:'item/completed',params:{threadId:p.threadId,turnId:id,item}});
  send({method:'turn/completed',params:{threadId:p.threadId,turn:{id,status:'completed',items:[item]}}});return
 }
 if(m.id!==undefined)send({id:m.id,result:{}})
});
`, { mode: 0o700 });
  const { stdout } = await promisify(execFile)(process.execPath, [resolve("dist/scripts/evaluate-tasks.js"), "--suite", join(suite, "suite.json"),
    "--config", configFile, "--output", output, "--live", "--max-runs", "3"],
  { env: { ...process.env, FENJUE_CODEX_BIN: fixture, FENJUE_FIXTURE_TRACE: traceFile }, timeout: 30000 });
  assert.match(stdout, /completed/);
  const report = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
  assert.equal(report.complete, true); assert.equal(report.baseline, "baseline");
  for (const row of report.rows) {
    assert.equal(row.acceptance.passed, true);
    assert.equal(row.usage.totalTokens, row.strategy === "baseline" ? 100 : 340);
    if (row.strategy === "baseline") continue;
    assert.equal(row.reviews.length, 2); assert.equal(row.revisions, 1);
    assert.equal(row.threadUsage.filter((r: any) => r.role === "architect").length, 2);
    const answer = await readFile(join(output, "runs", `repair-${row.strategy}-1`, "final-answer.txt"), "utf8");
    assert.doesNotMatch(answer, /ARCHITECT_ADVICE|IMPLEMENTATION_PLAN/);
    assert.match(answer, /DELIVERY_RESULT/);
  }
  const trace = (await readFile(traceFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(trace.filter(r => r.method === "thread/start" && r.params.ephemeral).length, 4);
  assert.ok(trace.filter(r => r.architect).every(r => r.params.sandboxPolicy.type === "readOnly"));
  const missingOutput = join(root, "missing-usage");
  await promisify(execFile)(process.execPath, [resolve("dist/scripts/evaluate-tasks.js"), "--suite", join(suite, "suite.json"),
    "--config", configFile, "--output", missingOutput, "--live", "--max-runs", "3"],
  { env: { ...process.env, FENJUE_CODEX_BIN: fixture, FENJUE_FIXTURE_TRACE: traceFile, FENJUE_FIXTURE_SKIP_EXPERT_USAGE: "1" }, timeout: 30000 });
  const missing = JSON.parse(await readFile(join(missingOutput, "report.json"), "utf8"));
  assert.ok(missing.rows.filter((r: any) => r.strategy !== "baseline").every((r: any) => r.usage === null));
  const budgetSuite = JSON.parse(await readFile(join(suite, "suite.json"), "utf8"));
  budgetSuite.tasks[0].limits.tokens = 110;
  await writeFile(join(suite, "suite.json"), JSON.stringify(budgetSuite));
  const budgetOutput = join(root, "budget");
  await assert.rejects(() => promisify(execFile)(process.execPath, [resolve("dist/scripts/evaluate-tasks.js"), "--suite", join(suite, "suite.json"),
    "--config", configFile, "--output", budgetOutput, "--live", "--max-runs", "3"],
  { env: { ...process.env, FENJUE_CODEX_BIN: fixture, FENJUE_FIXTURE_TRACE: traceFile }, timeout: 30000 }), (error: any) => error.code === 1);
  const budget = JSON.parse(await readFile(join(budgetOutput, "report.json"), "utf8"));
  assert.equal(budget.rows.find((r: any) => r.strategy === "baseline").status, "completed");
  for (const row of budget.rows.filter((r: any) => r.strategy !== "baseline")) {
    assert.equal(row.status, "budget"); assert.equal(row.usage.totalTokens, 120); assert.equal(row.reviews.length, 1);
  }
  assert.deepEqual(classifier.errors, []);
});
