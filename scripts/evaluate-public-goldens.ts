// Public gold answers establish correctness; no hand-written route labels.
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { readConfig, type Route } from "../src/config.js";
import { createClassifier, QUESTIONS } from "../src/classification.js";
import { nativeSelection, nativePolicy, mainRoute } from "../src/native-policy.js";
import { NativeAppServer, nativeOverrides } from "./native-app-server.js";
import { usage } from "./compare-sol-routing.js";

export const SOURCES = {
  cruxeval: { repo: "cruxeval-org/cruxeval", revision: "b96af0450242eb4da433032b90998f25588a5d0f", count: 800,
    sha256: "8368b81047dc5014e4caf5a2f97604eff7644e0ecd7415e3ceeb184bbc2e0c96", license: "MIT" },
  humanevalplus: { repo: "evalplus/humanevalplus", revision: "d32357cf319e50e9c8d8dab5ea876c72b0fd321b", count: 164,
    sha256: "908377f1daf28dcb36846db73a5662b2e05a9907407c2696c89ad9d3b0b04492", license: "Apache-2.0" },
};
type Dataset = keyof typeof SOURCES;
type Task = { dataset: Dataset; id: string; prompt: string; gold: any };
const seed = "fenjue-public-goldens-v1";
export const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function sampledTasks(dataset: Dataset, rows: any[], count: number): Task[] {
  return rows.map(gold => ({ dataset, id: String(gold.id ?? gold.task_id), gold,
    prompt: dataset === "cruxeval"
      ? `Determine the exact Python return value of f(${gold.input}) for this code. Do not execute code or use tools. Return only a Python literal (preserve strings, tuples, lists and dictionaries), without explanation.\n\n${gold.code}`
      : `Implement the Python function specified below. Return a complete Python module including the function definition and any needed imports. Do not use tools. Do not include Markdown fences or explanations.\n\n${gold.prompt}`,
  })).sort((a, b) => hash(`${seed}:${dataset}:${a.id}`).localeCompare(hash(`${seed}:${dataset}:${b.id}`))).slice(0, count);
}
export function candidateRoutes(selected: Route, main: string): Route[] {
  const routes = [selected, { model: main, effort: "low" }, { model: main, effort: "high" }];
  return [...new Map(routes.map(r => [`${r.model}/${r.effort}`, r])).values()];
}
export function assertSameExperiment(current: Record<string, unknown>, previous: Record<string, unknown>): void {
  for (const key of Object.keys(current).filter(k => k !== "startedAt")) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) throw new Error(`Resume manifest mismatch: ${key}`);
  }
}
export function assertNoTools(types: string[]): void {
  const unexpected = types.filter(t => !["userMessage", "agentMessage", "reasoning"].includes(t));
  if (unexpected.length) throw new Error(`Unexpected tool or item: ${unexpected.join(",")}`);
}
type Verdict = { valid: boolean; passed: boolean; reason: string; detail?: string };
function verify(python: string, task: Task, answer: string): Promise<Verdict> {
  return new Promise((done, reject) => {
    const child = spawn(python, [resolve("scripts/public-goldens-verifier.py")], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timer);
      try { done(JSON.parse(output)); } catch { reject(new Error(`Verifier unavailable: ${errors.slice(-300)}`)); }
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify({ dataset: task.dataset, gold: task.gold, answer }));
  });
}
const answerSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

export async function main(args: string[]) {
  const flags = new Map<string, string>(); let live = false;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--live") { live = true; continue; }
    if (!["--cache", "--config", "--env-file", "--out", "--python", "--max-classifier-calls", "--max-model-calls", "--resume-from"].includes(arg) || !args[0] || flags.has(arg)) throw new Error(`Invalid argument: ${arg}`);
    flags.set(arg, args.shift()!);
  }
  const maxClassifierCalls = Number(flags.get("--max-classifier-calls") ?? 0), maxModelCalls = Number(flags.get("--max-model-calls") ?? 0);
  if (live && (!Number.isSafeInteger(maxClassifierCalls) || maxClassifierCalls < 48 || !Number.isSafeInteger(maxModelCalls) || maxModelCalls < 36)) {
    throw new Error("Live run requires --max-classifier-calls 48 --max-model-calls 36");
  }
  const config = await readConfig(resolve(flags.get("--config") ?? "examples/native-balanced.json"));
  if (!config.semantic) throw new Error("semantic config required");
  const cache = resolve(flags.get("--cache") ?? ".fenjue/public-goldens/cache");
  const python = resolve(flags.get("--python") ?? ".fenjue/public-goldens/venv/bin/python");
  const tasks: Task[] = [], executionIds = new Set<string>();
  for (const dataset of Object.keys(SOURCES) as Dataset[]) {
    const bytes = await readFile(join(cache, `${dataset}.jsonl`));
    if (hash(bytes) !== SOURCES[dataset].sha256) throw new Error(`${dataset}: source hash mismatch`);
    const rows = bytes.toString().trim().split("\n").map(line => JSON.parse(line));
    if (rows.length !== SOURCES[dataset].count) throw new Error(`${dataset}: source row count mismatch`);
    const chosen = sampledTasks(dataset, rows, 24);
    tasks.push(...chosen); chosen.slice(0, 6).forEach(t => executionIds.add(`${dataset}:${t.id}`));
  }
  const out = resolve(flags.get("--out") ?? `.fenjue/public-goldens/${Date.now()}`);
  await mkdir(out, { recursive: false });
  const manifest = { version: 1, mode: live ? "live" : "preflight", startedAt: new Date().toISOString(), seed, sources: SOURCES,
    policy: nativePolicy(config), questionnaireDigest: hash(JSON.stringify(QUESTIONS)), classifier: config.semantic.model,
    routes: config.routes, expertModel: config.native?.expertModel ?? null, minConfidence: config.semantic.minConfidence,
    sampling: "SHA256(seed:dataset:id) ascending; first 24 per dataset classify, first 6 per dataset execute; no difficulty strata",
    candidates: "selected route plus main-model low and high, deduplicated; no universal fixed-medium baseline",
    plannedClassifierCalls: 48, maxPlannedModelCalls: 36, modelDeadlineMs: 120000,
    tools: "disabled; fresh ephemeral thread; no benchmark gold or tests in model input; Python output literal or full module in JSON answer",
    verifier: "CRUXEval Python literal equality (stricter format than official expression grader); HumanEval+ pinned HF check(candidate)",
    evaluation: "single-turn categorical route selection using actual Jev scores; no task execution tools or expert review; no gold route labels",
    tasks: tasks.map(({ gold, ...t }) => ({ ...t, execute: executionIds.has(`${t.dataset}:${t.id}`), goldDigest: hash(JSON.stringify(gold)) })) };
  let prior: any;
  if (flags.has("--resume-from")) {
    if (!live) throw new Error("Resume requires --live");
    const directory = resolve(flags.get("--resume-from")!);
    const previous = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assertSameExperiment(manifest, previous);
    prior = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    Object.assign(manifest, { resumedFrom: directory, previousReportDigest: hash(JSON.stringify(prior)) });
  }
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const preflight: any[] = [];
  for (const task of tasks.filter(t => executionIds.has(`${t.dataset}:${t.id}`))) {
    const answer = task.dataset === "cruxeval" ? task.gold.output : task.gold.prompt + task.gold.canonical_solution;
    const good = await verify(python, task, answer), bad = await verify(python, task, task.dataset === "cruxeval" ? "'__wrong_gold__'" : "");
    preflight.push({ dataset: task.dataset, id: task.id, good, bad });
    if (!good.valid || !good.passed || !bad.valid || bad.passed) throw new Error(`Verifier preflight failed: ${task.id}`);
  }
  await writeFile(join(out, "preflight.json"), JSON.stringify(preflight, null, 2) + "\n");
  if (!live) { console.log(JSON.stringify({ out, paidCalls: 0, preflight: "passed", plannedClassifierCalls: 48, maxPlannedModelCalls: 36 })); return; }
  const key = config.semantic.apiKeyEnv;
  if (key && flags.has("--env-file")) process.env[key] = parseEnv(await readFile(flags.get("--env-file")!, "utf8"))[key];
  if (key && !process.env[key]) throw new Error(`Missing ${key}`);
  const classifications: any[] = prior?.classifications ?? [], executions: any[] = prior?.executions ?? [];
  let classifierCalls = prior?.classifierCalls ?? 0, modelCalls = prior?.modelCalls ?? 0, app: NativeAppServer | undefined, temp: string | undefined;
  const controller = new AbortController();
  const stop = () => { controller.abort(); app?.child.kill("SIGTERM"); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const save = async () => writeFile(join(out, "report.json"), JSON.stringify({ updatedAt: new Date().toISOString(), classifierCalls, modelCalls, classifications, executions }, null, 2) + "\n");
  try {
    let tokens = usage(null);
    const classify = createClassifier(config.semantic, undefined, async (input, init) => {
      const response = await fetch(input, init);
      if (response.ok) tokens = usage((await response.clone().json()).usage);
      return response;
    });
    for (const task of tasks) {
      if (classifications.some(r => r.dataset === task.dataset && r.id === task.id && r.selection)) continue;
      controller.signal.throwIfAborted();
      if (classifierCalls >= maxClassifierCalls) throw new Error("Classifier budget exhausted");
      tokens = usage(null); classifierCalls++; const begin = performance.now();
      const row: any = { dataset: task.dataset, id: task.id };
      try {
        const classified = await classify({ currentTask: { messages: [], evidence: [], incomplete: false }, newMessages: [task.prompt], evidence: [], incomplete: false }, controller.signal);
        Object.assign(row, { classification: classified, selection: nativeSelection(config, classified) });
      } catch (error) { row.error = String(error); }
      Object.assign(row, { elapsedMs: Math.round(performance.now() - begin), usage: tokens });
      classifications.push(row); await save();
      console.log(JSON.stringify({ phase: "classify", id: task.id, route: row.selection?.route, error: row.error }));
      if (row.error) throw new Error("Classifier unavailable; stopped with partial report");
    }
    const executable = process.env.FENJUE_CODEX_BIN ?? "codex";
    temp = await mkdtemp(join(tmpdir(), "fenjue-gold-model-"));
    const settings = { model_provider: "openai", project_doc_max_bytes: 0, web_search: "disabled", "shell_environment_policy.inherit": "none",
      sqlite_home: temp, log_dir: temp, "tools.view_image": false, "features.skip_host_skill_discovery": true,
      ...Object.fromEntries(["multi_agent", "memories", "hooks", "plugins", "apps", "remote_plugin", "shell_snapshot", "shell_tool", "exec_tool",
        "code_mode_host", "sleep_tool", "skill_search", "tool_suggest", "unified_exec", "reasoning_effort_override"].map(f => [`features.${f}`, false])) };
    const setupStarted = performance.now();
    const childEnv = { ...process.env }; if (key) delete childEnv[key];
    app = new NativeAppServer(executable, ["app-server", ...nativeOverrides(settings)], childEnv);
    app.onRequest = async () => { throw new Error("Benchmark forbids tools or user input"); };
    await app.initialize();
    const effective = await app.request("config/read", { cwd: temp, includeLayers: false });
    const disabledServers = Object.fromEntries(Object.entries(effective.config.mcp_servers ?? {}).map(([name, server]: [string, any]) =>
      [name, { ...(typeof server.command === "string" ? { command: server.command } : { url: server.url }), enabled: false }]));
    const skills = await app.request("skills/list", { cwds: [temp] });
    const disabledSkills = skills.data.flatMap((e: any) => e.skills).map((s: any) => ({ path: s.path, enabled: false }));
    Object.assign(manifest, { runtime: { codexVersion: execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(),
      pythonVersion: execFileSync(python, ["--version"], { encoding: "utf8" }).trim(),
      numpyVersion: execFileSync(python, ["-c", "import numpy; print(numpy.__version__)"], { encoding: "utf8" }).trim(),
      setupMs: Math.round(performance.now() - setupStarted), settings } });
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const [index, task] of tasks.filter(t => executionIds.has(`${t.dataset}:${t.id}`)).entries()) {
      const selected = classifications.find(r => r.dataset === task.dataset && r.id === task.id && r.selection).selection.route as Route;
      const candidates = candidateRoutes(selected, mainRoute(config).model), offset = index % candidates.length;
      for (const route of [...candidates.slice(offset), ...candidates.slice(0, offset)]) {
        if (executions.some(r => r.dataset === task.dataset && r.id === task.id && r.route.model === route.model && r.route.effort === route.effort && r.verdict?.valid)) continue;
        controller.signal.throwIfAborted();
        if (modelCalls >= maxModelCalls) throw new Error("Model budget exhausted");
        modelCalls++; const began = performance.now(), from = app.messages.length;
        const remaining = () => Math.max(1, 120000 - (performance.now() - began));
        let threadId: string | undefined;
        const row: any = { dataset: task.dataset, id: task.id, route, selected: route.model === selected.model && route.effort === selected.effort, usage: usage(null) };
        try {
          const instructions = "Solve the supplied benchmark task. Use no tools. Put only the requested answer in the JSON answer string. Do not seek external data.";
          const thread = await app.request("thread/start", { cwd: temp, model: route.model, modelProvider: "openai", allowProviderModelFallback: false,
            ephemeral: true, sandbox: "read-only", approvalPolicy: "never", baseInstructions: instructions, developerInstructions: instructions,
            config: { ...settings, mcp_servers: disabledServers, "skills.config": disabledSkills, model_reasoning_effort: route.effort } }, remaining());
          threadId = thread.thread.id;
          if (thread.model !== route.model) throw new Error("Model mismatch");
          const turn = await app.request("turn/start", { threadId, input: [{ type: "text", text: task.prompt }], ...route,
            outputSchema: answerSchema, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } }, remaining());
          const done = await app.waitFor(m => m.method === "turn/completed" && m.params.threadId === threadId && m.params.turn.id === turn.turn.id, from, remaining());
          const events = app.messages.slice(from).filter(m => m.params?.threadId === threadId);
          row.turnError = done.params.turn.error ?? undefined;
          row.usage = usage(events.findLast(m => m.method === "thread/tokenUsage/updated")?.params.tokenUsage.total, true);
          if (done.params.turn.status !== "completed") throw new Error(`Incomplete turn: ${done.params.turn.status}`);
          if (events.some(m => m.method === "model/rerouted")) throw new Error("Model rerouted");
          row.itemTypes = [...new Set(events.filter(m => m.method === "item/started").map(m => m.params.item?.type))];
          assertNoTools(row.itemTypes);
          const items = [...(done.params.turn.items ?? []), ...events.filter(m => m.method === "item/completed").map(m => m.params.item)];
          row.answer = JSON.parse(items.findLast(i => i.type === "agentMessage")?.text ?? "null")?.answer;
          if (typeof row.answer !== "string") throw new Error("Invalid answer schema");
        } catch (error) { row.error = String(error); }
        finally { if (threadId) await app.request("thread/archive", { threadId }, 3000).catch(() => {}); }
        row.elapsedMs = Math.round(performance.now() - began);
        if (!row.error) row.verdict = await verify(python, task, row.answer);
        executions.push(row); await save();
        console.log(JSON.stringify({ phase: "execute", id: task.id, route, selected: row.selected, passed: row.verdict?.passed, elapsedMs: row.elapsedMs, error: row.error }));
        if (row.error || !row.verdict?.valid) throw new Error("Execution infrastructure/format failure; stopped with partial report");
      }
    }
  } finally {
    await save(); process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await app?.close(); if (temp) await rm(temp, { recursive: true, force: true });
    console.log(JSON.stringify({ out, classifierCalls, modelCalls, executions: executions.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
