import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, lstat, copyFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { record, type Route } from "./config.js";
import type { ReviewCheckpoint, ReviewRecord } from "./architect-review.js";

export interface ExecutionTask {
  id: string; category: string; group: string; split: "calibration" | "holdout";
  origin: "synthetic" | "daily"; snapshot: string; prompts: string[];
  reviewCheckpoints?: ReviewCheckpoint[];
  acceptance: { argv: string[]; timeoutMs: number };
  limits: { wallMs: number; toolCalls: number; tokens: number };
}
export interface ExecutionSuite {
  version: 1; tasks: ExecutionTask[]; baseline?: string;
  strategies: ({ id: string; kind: "fixed"; route: Route } |
    { id: string; kind: "sol-auto" | "expert-auto"; expertModel?: string; expertPolicy?: "constraints" } |
    { id: string; kind: "advisor-auto"; advisorRoute: Route })[];
}
export function parseExecutionSuite(value: unknown): ExecutionSuite {
  const validId = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v);
  const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
  if (!record(value) || value.version !== 1 || !Array.isArray(value.tasks) || !value.tasks.length ||
      !Array.isArray(value.strategies) || value.strategies.length < 2) throw new Error("任务集需要 version=1、任务和至少两种策略");
  for (const task of value.tasks) {
    if (record(task) && task.reviewCheckpoints !== undefined && (!Array.isArray(task.reviewCheckpoints) ||
        task.reviewCheckpoints.some(v => !["plan", "repeated-error", "final"].includes(String(v))) ||
        new Set(task.reviewCheckpoints).size !== task.reviewCheckpoints.length)) throw new Error("无效 reviewCheckpoints");
    if (!record(task) || !validId(task.id) || !validId(task.category) || !validId(task.group) ||
        !["calibration", "holdout"].includes(String(task.split)) || !["synthetic", "daily"].includes(String(task.origin)) ||
        typeof task.snapshot !== "string" || !task.snapshot || !Array.isArray(task.prompts) || !task.prompts.length ||
        !task.prompts.every(p => typeof p === "string" && p.trim()) || !record(task.acceptance) ||
        !Array.isArray(task.acceptance.argv) || !task.acceptance.argv.length ||
        !task.acceptance.argv.every(a => typeof a === "string") || !positive(task.acceptance.timeoutMs) ||
        !record(task.limits) || ![task.limits.wallMs, task.limits.toolCalls, task.limits.tokens].every(positive)) {
      throw new Error("无效执行任务：需要快照、预定用户输入、验收 argv 和执行上限");
    }
  }
  for (const s of value.strategies) {
    if (!record(s) || !validId(s.id) || !["fixed", "sol-auto", "expert-auto", "advisor-auto"].includes(String(s.kind))) throw new Error("无效执行策略");
    if (s.kind === "fixed" && (!record(s.route) || typeof s.route.model !== "string" ||
        !["low", "medium", "high", "xhigh", "max", "ultra"].includes(String(s.route.effort)))) throw new Error("固定策略需要 model/effort");
    if (s.kind === "expert-auto" && (typeof s.expertModel !== "string" || !s.expertModel.trim())) throw new Error("专家策略需要 expertModel");
    if (s.expertPolicy !== undefined && (s.kind !== "expert-auto" || s.expertPolicy !== "constraints")) throw new Error("expertPolicy 仅支持 expert-auto 的 constraints 候选");
    if (s.kind === "advisor-auto" && (!record(s.advisorRoute) || typeof s.advisorRoute.model !== "string" || !s.advisorRoute.model.trim() ||
        !["low", "medium", "high", "xhigh", "max"].includes(String(s.advisorRoute.effort)))) throw new Error("审查策略需要 advisorRoute model/effort");
  }
  for (const list of [value.tasks, value.strategies]) if (new Set(list.map(v => v.id)).size !== list.length) throw new Error("任务和策略 id 不能重复");
  if (value.baseline !== undefined && !value.strategies.some(s => s.id === value.baseline)) throw new Error("baseline 必须引用任务集中的策略");
  const groups = new Map<string, string>();
  for (const task of value.tasks) {
    if (groups.has(task.group) && groups.get(task.group) !== task.split) throw new Error("同一 group 不得跨校准集和冻结集");
    groups.set(task.group, task.split);
  }
  return value as unknown as ExecutionSuite;
}

export function inside(root: string, path: string): string {
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel.startsWith(".." + "/") || rel === ".." || isAbsolute(rel)) throw new Error(`路径必须在任务集目录内：${path}`);
  return target;
}
export async function snapshotFiles(directory: string, paths?: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let bytes = 0;
  const selected = paths?.map(path => relative(directory, inside(directory, path)));
  if (selected) for (const path of selected) await lstat(join(directory, path));
  const walk = async (path: string) => {
    const rel = relative(directory, path);
    if (rel && selected && !selected.some(p => p === rel || p.startsWith(rel + "/") || rel.startsWith(p + "/"))) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`快照不接受符号链接：${relative(directory, path)}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        const child = relative(directory, join(path, name));
        if (selected && !selected.some(p => p === child || p.startsWith(child + "/") || child.startsWith(p + "/"))) continue;
        if ([".git", "node_modules", ".fenjue", ".codex", ".agents"].includes(name)) continue;
        if (/^\.env(?:\.|$)/.test(name) || /^(auth\.json|credentials|.*\.(pem|key))$/.test(name)) throw new Error(`快照包含凭据文件：${name}`);
        await walk(join(path, name));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 20 * 1024 * 1024) throw new Error("首版快照上限为 20 MiB；请准备独立任务夹具");
      files[relative(directory, path)] = createHash("sha256").update(await readFile(path)).digest("hex");
    } else throw new Error("快照只接受普通文件和目录");
  };
  await walk(directory);
  return files;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function copySnapshot(source: string, destination: string, files: Record<string, string>): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of Object.keys(files)) {
    const target = join(destination, name);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await copyFile(join(source, name), target);
  }
  if (digest(await snapshotFiles(destination)) !== digest(files)) throw new Error("快照复制期间文件发生变化");
}

export interface AcceptanceResult { passed: boolean; valid: boolean; exitCode: number | null; timedOut: boolean; output: string }
// Verifier lives outside the model's writable workspace. No classifier/auth key
// is inherited. Its result is captured, never fed into competing executions.
export async function acceptTask(task: ExecutionTask, suiteDirectory: string, workspace: string, answerFile: string): Promise<AcceptanceResult> {
  const argv = task.acceptance.argv.map(arg => arg.replaceAll("{suite}", suiteDirectory).replaceAll("{workspace}", workspace));
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: workspace, env: { ...env, FENJUE_WORKSPACE: workspace, FENJUE_FINAL_ANSWER: answerFile },
      stdio: ["ignore", "pipe", "pipe"], detached: true, shell: false });
    let output = "", timedOut = false;
    const consume = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32_000); };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    const timer = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } } }, task.acceptance.timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      let verdict: unknown;
      try { verdict = JSON.parse(output.trim().split("\n").at(-1)!); } catch { /* malformed verifier output */ }
      const valid = record(verdict) && typeof verdict.passed === "boolean" &&
        (verdict.passed ? code === 0 : code === 1) && !timedOut;
      resolve({ passed: valid && (verdict as any).passed === true, valid, exitCode: code, timedOut, output });
    });
  });
}
export interface ExecutionResult {
  task: string; category: string; split: string; strategy: string; repeat: number;
  status: "completed" | "failed" | "timeout" | "budget" | "infrastructure-error";
  acceptance?: AcceptanceResult; elapsedMs: number; toolCalls: number;
  usage: Record<string, number> | null; classifierCalls: number; classifierTokens: number; classifierMs: number;
  routes: Route[]; decisionReasons: string[]; reroutes?: { fromModel: unknown; toModel: unknown; reason: unknown }[]; error?: string;
  reviews?: ReviewRecord[];
  threadUsage?: { threadId: string; role: "main" | "architect"; usage: Record<string, number> | null }[];
  revisions?: number;
}
// Error discriminants from Codex 0.159.3's generated App Server schema.
// Network/account/runtime failures are not scored as model-quality losses.
export function nativeFailureStatus(info: unknown): ExecutionResult["status"] {
  if (["contextWindowExceeded", "sessionBudgetExceeded"].includes(String(info))) return "budget";
  if (["usageLimitExceeded", "rateLimitExceeded", "flexUnavailable", "serverOverloaded", "internalServerError", "unauthorized", "sandboxError"].includes(String(info)) ||
      (record(info) && ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].some(k => Object.hasOwn(info, k)))) return "infrastructure-error";
  return "failed";
}
export function pairedReport(suite: ExecutionSuite, rows: ExecutionResult[]) {
  const baseline = suite.baseline ?? suite.strategies.find(s => s.kind === "sol-auto")?.id ?? suite.strategies[0]!.id;
  const passed = (r: ExecutionResult) => r.status === "completed" && r.acceptance?.passed === true;
  return {
    baseline, origins: [...new Set(suite.tasks.map(t => t.origin))],
    summaries: suite.strategies.map(s => {
      const subset = rows.filter(r => r.strategy === s.id);
      return { strategy: s.id, executions: subset.length, passed: subset.filter(passed).length,
        infrastructureErrors: subset.filter(r => r.status === "infrastructure-error").length,
        elapsedMs: subset.reduce((n, r) => n + r.elapsedMs, 0),
        tokens: subset.every(r => r.usage !== null) ? subset.reduce((n, r) => n + (r.usage!.totalTokens ?? 0), 0) : null,
        cachedInputTokens: subset.every(r => r.usage !== null) ? subset.reduce((n, r) => n + (r.usage!.cachedInputTokens ?? 0), 0) : null,
        toolCalls: subset.reduce((n, r) => n + r.toolCalls, 0),
        classifierCalls: subset.reduce((n, r) => n + r.classifierCalls, 0),
        classifierTokens: subset.reduce((n, r) => n + r.classifierTokens, 0),
        classifierMs: subset.reduce((n, r) => n + r.classifierMs, 0),
        decisionReasons: Object.fromEntries([...new Set(subset.flatMap(r => r.decisionReasons))].map(reason =>
          [reason, subset.flatMap(r => r.decisionReasons).filter(r => r === reason).length])),
        expertTurns: s.kind === "expert-auto" ? subset.flatMap(r => r.routes).filter(r => r.model === s.expertModel).length : 0,
        reviews: subset.reduce((n, r) => n + (r.reviews?.length ?? 0), 0),
        reviewMs: subset.flatMap(r => r.reviews ?? []).reduce((n, r) => n + r.elapsedMs, 0),
        revisions: subset.reduce((n, r) => n + (r.revisions ?? 0), 0),
        reviewCheckpoints: Object.fromEntries(["plan", "repeated-error", "final"].map(checkpoint => [checkpoint,
          subset.flatMap(r => r.reviews ?? []).filter(r => r.checkpoint === checkpoint).length])) };
    }),
    pairs: suite.strategies.filter(s => s.id !== baseline).map(s => {
      const pairs = rows.filter(r => r.strategy === s.id).flatMap(candidate => {
        const reference = rows.find(r => r.strategy === baseline && r.task === candidate.task && r.repeat === candidate.repeat);
        if (!reference) return [];
        return [{ task: candidate.task, category: candidate.category, split: candidate.split, repeat: candidate.repeat,
          result: candidate.status === "infrastructure-error" || reference.status === "infrastructure-error" ? "infrastructure" :
            passed(candidate) === passed(reference) ? "tie" : passed(candidate) ? "win" : "loss",
          elapsedDeltaMs: candidate.elapsedMs - reference.elapsedMs,
          tokenDelta: candidate.usage && reference.usage ? (candidate.usage.totalTokens ?? 0) - (reference.usage.totalTokens ?? 0) : null }];
      });
      return { strategy: s.id, wins: pairs.filter(p => p.result === "win").length,
        losses: pairs.filter(p => p.result === "loss").length, ties: pairs.filter(p => p.result === "tie").length,
        infrastructurePairs: pairs.filter(p => p.result === "infrastructure").length, pairs };
    }),
    admission: "not-decided",
    note: "按任务配对的筛选报告；合成任务和小样本不证明日常质量等价，不自动更改模型准入。订阅费用未知。",
  };
}
export async function saveJSON(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
