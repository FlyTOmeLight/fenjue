import { execFile } from "node:child_process";
import { parseEnv, promisify } from "node:util";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readConfig, type Config } from "../src/config.js";
import { createClassifier } from "../src/classification.js";
import { redactCapture } from "../src/capture.js";
import { nativeArguments } from "../src/native-launcher.js";
import { startNativeGateway } from "../src/native-gateway.js";
import { validateNativeCatalog, nativePolicy } from "../src/native-policy.js";
import { NativeRecords } from "../src/native-records.js";
import { acceptTask, copySnapshot, digest, inside, nativeFailureStatus, pairedReport, parseExecutionSuite, saveJSON, snapshotFiles,
  type ExecutionResult, type ExecutionSuite, type ExecutionTask } from "../src/task-evaluation.js";
import { EvaluationClient } from "./native-evaluation-client.js";
import { ARCHITECT_POLICY, ARCHITECT_INSTRUCTIONS, completedWork, reviewPrompt, runArchitectTask,
  type WorkTurn } from "../src/architect-review.js";

const args = process.argv.slice(2), flags = new Map<string, string>();
let live = false;
while (args.length) {
  const flag = args.shift()!;
  if (flag === "--live") { live = true; continue; }
  if (flag === "--dry-run") continue;
  if (!["--suite", "--config", "--env-file", "--output", "--task", "--max-runs", "--repeats"].includes(flag) || !args.length) throw new Error(`未知或缺值参数：${flag}`);
  flags.set(flag, args.shift()!);
}
const suitePath = resolve(flags.get("--suite") ?? "evals/execution-pilot/suite.json");
const sourceDirectory = dirname(suitePath), original = parseExecutionSuite(JSON.parse(await readFile(suitePath, "utf8")));
const suite = { ...original, tasks: flags.has("--task") ? original.tasks.filter(t => t.id === flags.get("--task")) : original.tasks };
if (!suite.tasks.length) throw new Error("没有匹配任务");
const repeats = Number(flags.get("--repeats") ?? 1), runs = suite.tasks.length * suite.strategies.length * repeats;
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("repeats 范围为 1–10");
if (live && (!Number.isSafeInteger(Number(flags.get("--max-runs"))) || Number(flags.get("--max-runs")) < runs)) throw new Error(`需显式 --live --max-runs ${runs}；一次 run 是完整任务，包含多次模型/工具调用`);
const directory = resolve(flags.get("--output") ?? `.fenjue/execution/${Date.now()}`);
// Refuse existing directories: reports and frozen acceptance cannot be reused.
await mkdir(directory, { mode: 0o700, recursive: false }).catch(async error => {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
});
const frozen = join(directory, "suite"), allFiles = await snapshotFiles(sourceDirectory);
await copySnapshot(sourceDirectory, frozen, allFiles);
const snapshots = Object.fromEntries(await Promise.all(suite.tasks.map(async task => {
  const path = inside(frozen, task.snapshot), files = await snapshotFiles(path);
  if (!Object.keys(files).length) throw new Error(`空任务快照：${task.id}`);
  return [task.id, { path, files, digest: digest(files) }] as const;
})));
const manifest: Record<string, unknown> = { version: 1, mode: live ? "live" : "dry-run", suiteDigest: digest(allFiles),
  policies: Object.fromEntries(suite.strategies.map(s => [s.id, s.kind === "fixed" ? "fixed" :
    nativePolicy({ native: s.kind === "expert-auto" ? { expertPolicy: s.expertPolicy } : {} })])),
  suite, plannedExecutions: runs, repeats,
  ...(suite.strategies.some(s => s.kind === "advisor-auto") ? { architectPolicy: ARCHITECT_POLICY,
    architectInstructions: ARCHITECT_INSTRUCTIONS, maxReviewsPerTask: 3, reviewExecution: "isolated-read-only-thread" } : {}),
  snapshots: Object.fromEntries(Object.entries(snapshots).map(([id, s]) => [id, { digest: s.digest, files: s.files }])),
  tokenLimit: "observed soft limit; in-flight requests may exceed it", subscriptionCost: "unknown" };
await saveJSON(join(directory, "manifest.json"), manifest);
const preflight = [];
for (const task of suite.tasks) {
  const workspace = join(directory, "preflight", task.id), snapshot = snapshots[task.id]!;
  await copySnapshot(snapshot.path, workspace, snapshot.files);
  const answer = join(directory, "preflight", `${task.id}-answer.txt`); await writeFile(answer, "");
  const acceptance = await acceptTask(task, frozen, workspace, answer);
  preflight.push({ task: task.id, initialAcceptance: acceptance });
  await rm(workspace, { recursive: true, force: true }); await rm(answer);
}
await saveJSON(join(directory, "preflight.json"), preflight);
await rm(join(directory, "preflight"), { recursive: true, force: true });
if (preflight.some(p => p.initialAcceptance.passed || !p.initialAcceptance.valid)) {
  throw new Error("初始快照应尚未通过验收且验收器可正常运行；检查 preflight.json");
}
if (!live) {
  console.log(JSON.stringify({ mode: "dry-run", paidCalls: 0, tasks: suite.tasks.length, plannedExecutions: runs, report: directory,
    note: "已冻结快照并运行起始验收；尚未评价模型质量" }));
} else {
  const config = await readConfig(resolve(flags.get("--config") ?? "fenjue.config.json"));
  if (!config.semantic || config.auth === "mock") throw new Error("真实任务评测需要原生认证和 semantic 配置");
  const key = config.semantic.apiKeyEnv;
  if (key && flags.has("--env-file")) {
    const value = parseEnv(await readFile(flags.get("--env-file")!, "utf8"))[key];
    if (!value) throw new Error(`env 文件缺少 ${key}`); process.env[key] = value;
  }
  if (key && !process.env[key]) throw new Error(`缺少分类密钥环境变量 ${key}`);
  const secrets = [key, "OPENAI_API_KEY"].flatMap(k => k && process.env[k] ? [process.env[k]!] : []);
  const codex = process.env.FENJUE_CODEX_BIN ?? "codex", exec = promisify(execFile);
  const version = (await exec(codex, ["--version"])).stdout.trim();
  const catalog = JSON.parse(config.catalog ? await readFile(config.catalog, "utf8") :
    (await exec(codex, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024 })).stdout);
  for (const strategy of suite.strategies) {
    validateNativeCatalog(catalog, strategyConfig(config, strategy));
    if (strategy.kind === "fixed" && !catalog.models.some((m: any) => m.slug === strategy.route.model &&
        m.supported_reasoning_levels.some((r: any) => r.effort === strategy.route.effort))) throw new Error("固定模型组合不在原生目录");
    if (strategy.kind === "advisor-auto" && !catalog.models.some((m: any) => m.slug === strategy.advisorRoute.model &&
        (config.auth !== "api-key" || m.supported_in_api !== false) &&
        m.supported_reasoning_levels.some((r: any) => r.effort === strategy.advisorRoute.effort))) throw new Error("审查模型组合不在原生目录或不支持当前认证");
  }
  Object.assign(manifest, { codex: version, node: process.version, catalogDigest: digest(catalog), configDigest: digest(config), classifier: { model: config.semantic.model,
    provider: config.semantic.provider, minConfidence: config.semantic.minConfidence }, startedAt: new Date().toISOString() });
  config.catalog = join(directory, "catalog.json");
  await saveJSON(config.catalog, catalog);
  await saveJSON(join(directory, "manifest.json"), manifest);
  const rows: ExecutionResult[] = [], controller = new AbortController();
  const stop = () => controller.abort(new Error("Evaluation interrupted"));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    for (let repeat = 1; repeat <= repeats; repeat++) for (const [index, task] of suite.tasks.entries()) {
      // Rotate ordering to reduce systematic warm-cache/time-of-day bias.
      const order = (index + repeat - 1) % suite.strategies.length;
      const strategies = [...suite.strategies.slice(order), ...suite.strategies.slice(0, order)];
      for (const strategy of strategies) {
        controller.signal.throwIfAborted();
        const result = await execute(task, strategy, repeat, strategyConfig(config, strategy), codex, secrets, controller.signal);
        rows.push(result);
        const report = { ...pairedReport(suite, rows), mode: "live", complete: rows.length === runs, rows };
        await saveJSON(join(directory, "report.json"), report);
        console.log(JSON.stringify({ task: result.task, strategy: result.strategy, status: result.status,
          passed: result.acceptance?.passed ?? false, routes: result.routes, elapsedMs: result.elapsedMs, report: directory }));
        // Stop on infrastructure failure rather than spending the rest of a
        // batch on broken credentials/network/runtime. Preserve partial report.
        if (result.status === "infrastructure-error") throw new Error("基础设施失败，已保存部分报告并停止后续执行");
      }
    }
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  if (rows.some(r => r.status !== "completed" || !r.acceptance?.passed)) process.exitCode = 1;
}

function strategyConfig(config: Config, strategy: ExecutionSuite["strategies"][number]): Config {
  return { ...structuredClone(config), rules: [], capture: undefined,
    native: strategy.kind === "expert-auto" ? { expertModel: strategy.expertModel, expertPolicy: strategy.expertPolicy } : {},
    semantic: { ...config.semantic!, mode: "auto" } };
}
async function execute(task: ExecutionTask, strategy: ExecutionSuite["strategies"][number], repeat: number,
  config: Config, executable: string, secrets: string[], signal: AbortSignal): Promise<ExecutionResult> {
  const runDir = join(directory, "runs", `${task.id}-${strategy.id}-${repeat}`), workspace = join(runDir, "workspace");
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const snapshot = snapshots[task.id]!; await copySnapshot(snapshot.path, workspace, snapshot.files);
  const temp = await mkdtemp(join(tmpdir(), "fenjue-task-")), socket = join(temp, "app.sock");
  const row: ExecutionResult = { task: task.id, category: task.category, split: task.split, strategy: strategy.id, repeat,
    status: "infrastructure-error", elapsedMs: 0, toolCalls: 0, usage: null,
    classifierCalls: 0, classifierTokens: 0, classifierMs: 0, routes: [], decisionReasons: [], reroutes: [],
    reviews: [], threadUsage: [], revisions: 0 };
  let gateway: Awaited<ReturnType<typeof startNativeGateway>> | undefined, client: EvaluationClient | undefined;
  let threadId: string | undefined, activeThread: string | undefined, activeTurn: string | undefined, budgetHit = false, timeoutHit = false;
  const ownedThreads = new Map<string, "main" | "architect">(), usage = new Map<string, Record<string, number>>();
  const mainAnswers: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const started = Date.now(), remaining = () => Math.max(1, task.limits.wallMs - (Date.now() - started));
  const interrupt = () => {
    if (activeThread) void client?.request("turn/interrupt", { threadId: activeThread, ...(activeTurn ? { turnId: activeTurn } : {}) }, 3000).catch(() => {});
  };
  const stop = () => { interrupt(); client?.close(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const settings = { sqlite_home: temp, log_dir: temp, "features.apps": false, "features.plugins": false,
      "sandbox_workspace_write.writable_roots": [], "sandbox_workspace_write.network_access": false,
      "sandbox_workspace_write.exclude_tmpdir_env_var": true, "sandbox_workspace_write.exclude_slash_tmp": true,
      "features.remote_plugin": false, "features.hooks": false, "features.memories": false, "features.shell_snapshot": false,
      "features.multi_agent": false, "features.skip_host_skill_discovery": true, "features.unbounded_connection_retries": false,
      "features.reasoning_effort_override": false };
    const serverArgs = nativeArguments(config, Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`])).server;
    const env = { ...process.env }; if (config.semantic!.apiKeyEnv !== "OPENAI_API_KEY") delete env[config.semantic!.apiKeyEnv ?? ""];
    const records = new NativeRecords(runDir, join(runDir, "capture"), secrets, message => { throw new Error(message); });
    const classify = createClassifier(config.semantic!, undefined, undefined, config.native?.expertPolicy === "constraints");
    gateway = await startNativeGateway({ socket, executable, serverArgs, env, config, records, initialManual: strategy.kind === "fixed",
      classify: async (view, cancel) => {
        row.classifierCalls++; const begin = Date.now();
        try { const result = await classify(view, cancel); row.classifierTokens += result.inputTokens; return result; }
        finally { row.classifierMs += Date.now() - begin; }
      }, onEvent: event => {
        if (event.type === "accepted" && event.route) { row.routes.push(event.route); row.decisionReasons.push(String(event.reason)); }
        if (event.type === "rerouted") row.reroutes!.push({ fromModel: event.fromModel, toModel: event.toModel, reason: event.reason });
      }, onFailure: () => client?.close() });
    signal.throwIfAborted();
    client = new EvaluationClient(socket, message => {
      if (!ownedThreads.has(message.params?.threadId)) return;
      if (message.method === "turn/started") { activeThread = message.params.threadId; activeTurn = message.params.turn.id; }
      if (message.method === "model/rerouted" && ownedThreads.get(message.params.threadId) === "architect") {
        row.reroutes!.push({ fromModel: message.params.fromModel, toModel: message.params.toModel, reason: message.params.reason });
      }
      if (message.method === "thread/tokenUsage/updated") {
        const total = message.params.tokenUsage?.total;
        if (total && Number.isSafeInteger(total.totalTokens)) usage.set(message.params.threadId, total);
        if ([...usage.values()].reduce((n, u) => n + u.totalTokens!, 0) >= task.limits.tokens) { budgetHit = true; interrupt(); }
      }
      if (message.method === "item/started" && ["commandExecution", "mcpToolCall", "fileChange", "webSearch", "imageView"].includes(message.params.item.type)) {
        row.toolCalls++;
        if (row.toolCalls > task.limits.toolCalls) { budgetHit = true; interrupt(); }
      }
    });
    timer = setTimeout(() => { timeoutHit = true; interrupt(); client?.close(); }, remaining());
    await client.open(); signal.throwIfAborted();
    const initial = strategy.kind === "fixed" ? strategy.route : config.routes[config.semantic!.roles.balanced]!;
    threadId = (await client.request("thread/start", { threadSource: "user", cwd: workspace, sandbox: "workspace-write",
      approvalPolicy: "never", ephemeral: false, model: initial.model, config: { model_reasoning_effort: initial.effort } }, remaining())).thread.id;
    ownedThreads.set(threadId!, "main");
    const runTurn = async (id: string, prompt: string, route: { model: string; effort: string }, readOnly: boolean): Promise<WorkTurn> => {
      signal.throwIfAborted();
      if (budgetHit || timeoutHit) throw new Error("任务执行预算已耗尽");
      activeThread = id;
      const result = await client!.request("turn/start", { threadId: id, input: [{ type: "text", text: prompt }], ...route,
        sandboxPolicy: readOnly ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [],
          networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
        collaborationMode: { mode: "default", settings: { model: route.model, reasoning_effort: route.effort,
          developer_instructions: readOnly && ownedThreads.get(id) === "architect" ? ARCHITECT_INSTRUCTIONS : null } } }, remaining());
      activeTurn = result.turn.id;
      const done = await client!.completed(activeTurn!, remaining()); activeTurn = undefined; activeThread = undefined;
      if (budgetHit || done.params.turn.status !== "completed") {
        row.status = budgetHit ? "budget" : nativeFailureStatus(done.params.turn.error?.codexErrorInfo);
        row.error = JSON.stringify(done.params.turn.error ?? {});
      } else row.status = "completed";
      const items = client!.messages.filter(m => m.method === "item/completed" && m.params.threadId === id && m.params.turnId === done.params.turn.id)
        .map(m => m.params.item);
      return completedWork(id, { ...done.params.turn, status: row.status, items: [...items, ...(done.params.turn.items ?? [])] });
    };
    const main = async (prompt: string, phase: "plan" | "implementation" | "revision") => {
      if (phase === "revision") row.revisions!++;
      const work = await runTurn(threadId!, prompt, initial, phase === "plan");
      if (phase !== "plan") mainAnswers.push(work.answer);
      return work;
    };
    if (strategy.kind === "advisor-auto") await runArchitectTask(task, { main,
      review: async (checkpoint, prompts, work, evidence) => {
        const begin = Date.now(), route = strategy.advisorRoute;
        signal.throwIfAborted();
        if (budgetHit || timeoutHit) throw new Error("审查前任务预算已耗尽");
        const id = (await client!.request("thread/start", { cwd: workspace, sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
          model: route.model, developerInstructions: ARCHITECT_INSTRUCTIONS, config: { model_reasoning_effort: route.effort } }, remaining())).thread.id;
        ownedThreads.set(id, "architect");
        const before = digest(await snapshotFiles(workspace));
        const result = await runTurn(id, reviewPrompt(checkpoint, prompts, work, evidence), route, true);
        const advice = redactCapture(result.answer, secrets);
        row.reviews!.push({ checkpoint, route, threadId: id, turnId: result.turnId, parentTurnId: work.turnId,
          elapsedMs: Date.now() - begin, advice, evidence: redactCapture(evidence, secrets) });
        await saveJSON(join(runDir, "reviews.json"), row.reviews);
        if (before !== digest(await snapshotFiles(workspace))) throw new Error("只读审查改变了工作区，评测无效");
        if (result.status !== "completed" || !advice.trim()) throw new Error("专家审查未完成或没有最终意见");
        return advice;
      } });
    else for (const prompt of task.prompts) {
      if ((await main(prompt, "implementation")).status !== "completed") break;
    }
    clearTimeout(timer); timer = undefined;
    const answerFile = join(runDir, "final-answer.txt");
    await writeFile(answerFile, redactCapture(mainAnswers.join("\n\n"), secrets), { mode: 0o600 });
    if (digest(await snapshotFiles(frozen)) !== manifest.suiteDigest) throw new Error("冻结任务集或验收脚本在执行期间发生变化");
    row.acceptance = await acceptTask(task, frozen, workspace, answerFile);
    if (!row.acceptance.valid) { row.status = "infrastructure-error"; row.error = "验收器异常，请检查验收输出"; }
    row.acceptance.output = redactCapture(row.acceptance.output, secrets);
    const after = await snapshotFiles(workspace);
    await saveJSON(join(runDir, "changes.json"), [...new Set([...Object.keys(snapshot.files), ...Object.keys(after)])]
      .filter(name => snapshot.files[name] !== after[name]).map(name => ({ path: name, before: snapshot.files[name] ?? null, after: after[name] ?? null })));
  } catch (error) {
    row.status = timeoutHit ? "timeout" : budgetHit ? "budget" : row.status === "completed" ? "infrastructure-error" : row.status;
    row.error = redactCapture(String(error), secrets);
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", stop);
    if (activeThread && activeTurn && client) {
      await client.request("turn/interrupt", { threadId: activeThread, turnId: activeTurn }, 3000).catch(() => {});
      await client.completed(activeTurn, 3000).catch(() => {});
    }
    for (const id of ownedThreads.keys()) if (client) await client.request("thread/archive", { threadId: id }, 3000).catch(() => {});
    client?.close(); await gateway?.close(); await rm(temp, { recursive: true, force: true });
    row.threadUsage = [...ownedThreads].map(([id, role]) => ({ threadId: id, role, usage: usage.get(id) ?? null }));
    row.usage = row.threadUsage.length && row.threadUsage.every(t => t.usage !== null) ?
      Object.fromEntries([...new Set([...usage.values()].flatMap(u => Object.keys(u)))].map(k => [k, [...usage.values()].reduce((n, u) => n + (u[k] ?? 0), 0)])) : null;
    row.elapsedMs = Date.now() - started;
    await saveJSON(join(runDir, "result.json"), row);
  }
  return row;
}
