import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { record, type Route } from "./config.js";
import { redactCapture } from "./capture.js";
import { captureFrames } from "./cases.js";
import { fingerprint } from "./task-state.js";

export type Outcome = "accepted" | "rework" | "blocked";
export type FailureCause = "reasoning" | "implementation" | "requirements" | "environment" | "unknown";
export interface TaskFeedback {
  version: 1; id: string; time: string; threadId: string; taskId: string; turnId?: string;
  outcome: Outcome; cause: FailureCause; reviewer: string; reason: string; evidence?: string;
}
export interface ObservedTask {
  taskId: string; threadId: string; firstSeen: string; lastSeen: string; preview?: string;
  captures: string[]; logs: string[]; policies: string[];
  turns: { turnId: string; time: string; route: Route; reason: string; status?: string; elapsedMs?: number }[];
  observedTokens: number | null;
  reviews: { parentTurnId: string; time: string; route: Route; status: string; tokens: number | null;
    elapsedMs?: number; advice?: string; error?: string }[];
  feedback: TaskFeedback[];
}
async function names(directory: string): Promise<string[]> {
  return readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
}
async function events(path: string): Promise<any[]> {
  const text = await readFile(path, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => {
    const value: unknown = JSON.parse(line);
    if (!record(value) || typeof value.type !== "string" || typeof value.time !== "string" || !Number.isFinite(Date.parse(value.time))) {
      throw new Error(`无效原生记录：${path}`);
    }
    return value;
  });
}
export async function readFeedback(directory: string): Promise<TaskFeedback[]> {
  const rows: TaskFeedback[] = [];
  for (const name of (await names(directory)).filter(n => /^feedback-[a-f0-9-]+\.json$/.test(n)).sort()) {
    const v: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
    if (!record(v) || v.version !== 1 || !["accepted", "rework", "blocked"].includes(String(v.outcome)) ||
        !["reasoning", "implementation", "requirements", "environment", "unknown"].includes(String(v.cause)) ||
        !["id", "time", "threadId", "taskId", "reviewer", "reason"].every(k => typeof v[k] === "string" && String(v[k]).trim()) ||
        !Number.isFinite(Date.parse(String(v.time))) || (v.turnId !== undefined && typeof v.turnId !== "string") ||
        (v.evidence !== undefined && typeof v.evidence !== "string")) throw new Error(`无效反馈记录：${name}`);
    rows.push(v as unknown as TaskFeedback);
  }
  return rows.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}

// Native task ids survive resume. Historical Responses captures have no task
// identity and cannot be assigned invented outcomes by this report.
export async function observedTasks(directory: string, captureDirectory = join(directory, "daily")): Promise<ObservedTask[]> {
  const tasks = new Map<string, ObservedTask>(), seenUsage = new Set<string>();
  const rows = [];
  for (const name of (await names(directory)).filter(n => /^native-\d+-\d+\.jsonl$/.test(n)).sort()) {
    const path = join(directory, name);
    for (const event of await events(path)) rows.push({ event, path });
  }
  rows.sort((a, b) => a.event.time.localeCompare(b.event.time));
  for (const { event: e, path } of rows) {
    if (typeof e.taskId !== "string" || typeof e.threadId !== "string" || !e.turnId) continue;
    let task = tasks.get(e.taskId);
    if (!task && e.type === "accepted") {
      task = { taskId: e.taskId, threadId: e.threadId, firstSeen: e.time, lastSeen: e.time,
        captures: [], logs: [], policies: [], turns: [], reviews: [], observedTokens: null, feedback: [] };
      tasks.set(e.taskId, task);
    }
    if (!task) continue;
    if (task.threadId !== e.threadId) throw new Error("taskId 对应多个会话，无法关联反馈");
    if (!task.logs.includes(path)) task.logs.push(path);
    task.lastSeen = e.time;
    if (typeof e.policy === "string" && !task.policies.includes(e.policy)) task.policies.push(e.policy);
    if (e.type === "review-started" && record(e.reviewRoute) && !task.reviews.some(r => r.parentTurnId === e.turnId)) {
      task.reviews.push({ parentTurnId: e.turnId, time: e.time, route: e.reviewRoute as unknown as Route, status: "running-or-unobserved", tokens: null });
    }
    if (e.type === "review-finished") {
      const review = task.reviews.find(r => r.parentTurnId === e.turnId);
      if (review) Object.assign(review, { status: e.status, tokens: e.tokens ?? null, elapsedMs: e.elapsedMs, advice: e.advice, error: e.error });
    }
    let turn = task.turns.find(t => t.turnId === e.turnId);
    if (e.type === "accepted" && !turn) {
      if (!record(e.route) || typeof e.route.model !== "string" || typeof e.route.effort !== "string") throw new Error("提交记录缺少 model/effort");
      turn = { turnId: e.turnId, time: e.time, route: e.route as unknown as Route, reason: e.reason ?? "unknown" };
      task.turns.push(turn);
    }
    if (!turn) continue;
    if (e.type === "completed") {
      turn.status = e.status;
      turn.elapsedMs = Math.max(0, Date.parse(e.time) - Date.parse(turn.time));
    }
    if (e.type === "usage" && Number.isSafeInteger(e.tokenUsage?.last?.totalTokens) && e.tokenUsage.last.totalTokens >= 0 &&
        Number.isSafeInteger(e.tokenUsage?.total?.totalTokens)) {
      const key = `${e.threadId}:${e.turnId}:${e.tokenUsage.total.totalTokens}`;
      if (!seenUsage.has(key)) { task.observedTokens = (task.observedTokens ?? 0) + e.tokenUsage.last.totalTokens; seenUsage.add(key); }
    }
  }
  for (const name of (await names(captureDirectory)).filter(n => /^capture-\d+-\d+\.jsonl$/.test(n)).sort()) {
    const path = join(captureDirectory, name);
    for (const frame of await captureFrames(path)) {
      const task = tasks.get((frame as any).taskId);
      if (!task || frame.thread !== fingerprint(task.threadId)) continue;
      if (!task.captures.includes(path)) task.captures.push(path);
      task.preview ??= frame.items.find(i => i.kind === "user")?.text.slice(0, 120);
    }
  }
  for (const feedback of await readFeedback(join(directory, "feedback"))) {
    const task = tasks.get(feedback.taskId);
    if (task && task.threadId === feedback.threadId) task.feedback.push(feedback);
  }
  return [...tasks.values()];
}

export async function addFeedback(directory: string, input: Omit<TaskFeedback, "version" | "id" | "time" | "threadId">,
  now = new Date()): Promise<TaskFeedback> {
  if (!["accepted", "rework", "blocked"].includes(input.outcome) ||
      !["reasoning", "implementation", "requirements", "environment", "unknown"].includes(input.cause) ||
      !input.reviewer?.trim() || !input.reason?.trim()) throw new Error("反馈需要有效 outcome/cause、reviewer 和具体 reason");
  const task = (await observedTasks(directory)).find(t => t.taskId === input.taskId);
  if (!task) throw new Error("未找到已提交的原生 taskId；请先运行 feedback list");
  if (input.turnId && !task.turns.some(t => t.turnId === input.turnId)) throw new Error("turnId 不属于该任务");
  const secrets = ["OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"].flatMap(k => process.env[k] ? [process.env[k]!] : []);
  const feedback: TaskFeedback = { ...input, threadId: task.threadId, version: 1, id: randomUUID(), time: now.toISOString(),
    reviewer: input.reviewer.trim(), reason: redactCapture(input.reason.trim(), secrets),
    ...(input.evidence ? { evidence: redactCapture(input.evidence, secrets) } : {}) };
  const folder = join(directory, "feedback"); await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, `feedback-${feedback.id}.json`), JSON.stringify(feedback, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return feedback;
}

export function iterationReport(tasks: ObservedTask[], days = 7, now = new Date()) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("days 范围为 1–365");
  const until = now.toISOString(), since = new Date(now.getTime() - days * 86400000).toISOString();
  const selected = tasks.flatMap(task => {
    const turns = task.turns.filter(t => t.time >= since && t.time <= until);
    const feedback = task.feedback.filter(f => f.time <= until);
    const periodFeedback = feedback.some(f => f.time >= since);
    if (!turns.length && !periodFeedback) return [];
    // Turn-scoped feedback cannot label an entire multi-turn task as accepted.
    const lastTurnTime = task.turns.filter(t => t.time <= until).map(t => t.time).sort().at(-1);
    const latest = feedback.filter(f => !f.turnId && (!lastTurnTime || f.time >= lastTurnTime)).at(-1);
    return [{ ...task, turns, feedback, outcome: latest?.outcome ?? "unknown", cause: latest?.cause ?? "unknown",
      periodReviewTokens: task.turns.length === turns.length && task.lastSeen <= until && task.reviews.every(r => r.tokens !== null) ?
        task.reviews.reduce((n, r) => n + r.tokens!, 0) : null,
      periodObservedTokens: task.turns.length === turns.length && task.lastSeen <= until ? task.observedTokens : null }];
  });
  const count = (items: string[]) => Object.fromEntries([...new Set(items)].sort().map(k => [k, items.filter(v => v === k).length]));
  const turns = selected.flatMap(t => t.turns);
  const candidates = selected.map(t => ({ taskId: t.taskId, threadId: t.threadId, preview: t.preview,
    outcome: t.outcome, feedback: t.feedback, turnFeedback: t.feedback.filter(f => f.turnId), cause: t.cause,
    reasons: [...new Set([
      ...(t.outcome === "rework" ? ["需要返工"] : []), ...(t.outcome === "blocked" ? ["执行受阻"] : []),
      ...(t.feedback.some(f => f.turnId && f.outcome !== "accepted") ? ["轮次反馈需审核"] : []),
      ...(t.turns.some(r => r.status && r.status !== "completed") ? ["原生执行未完成"] : []),
      ...(t.turns.some(r => r.reason === "low-confidence") ? ["分类低置信度"] : []),
      ...(t.outcome === "unknown" ? ["缺少任务反馈"] : [])])],
    logs: t.logs, captures: t.captures, policies: t.policies, reviews: t.reviews }));
  const mainTokens = selected.length && selected.every(t => t.periodObservedTokens !== null) ? selected.reduce((n, t) => n + t.periodObservedTokens!, 0) : null;
  const reviewTokens = selected.every(t => t.periodReviewTokens !== null) ? selected.reduce((n, t) => n + t.periodReviewTokens!, 0) : null;
  const reviews = selected.flatMap(t => t.reviews.filter(r => r.time >= since && r.time <= until));
  return { version: 1, since, until, summary: { tasks: selected.length, turns: turns.length,
    outcomes: count(selected.map(t => t.outcome)), statuses: count(turns.map(t => t.status ?? "running-or-unobserved")),
    routes: count(turns.map(t => `${t.route.model}/${t.route.effort}`)), reasons: count(turns.map(t => t.reason)),
    recordedExecutionMs: turns.reduce((n, t) => n + (t.elapsedMs ?? 0), 0), timedTurns: turns.filter(t => t.elapsedMs !== undefined).length,
    observedTokens: mainTokens !== null && reviewTokens !== null ? mainTokens + reviewTokens : null,
    mainObservedTokens: mainTokens, reviewObservedTokens: reviewTokens, reviews: reviews.length,
    reviewStatuses: count(reviews.map(r => r.status)), recordedReviewMs: reviews.reduce((n, r) => n + (r.elapsedMs ?? 0), 0),
    automaticRevisions: turns.filter(t => t.reason === "architect-revision").length },
    candidates: candidates.sort((a, b) => Number(b.outcome === "rework" || b.outcome === "blocked") - Number(a.outcome === "rework" || a.outcome === "blocked") || a.taskId.localeCompare(b.taskId)),
    note: "反馈为人工声明；completed 不等于验收通过。token 是已记录请求的用量，缺失或跨报告窗口时为 null；不推算费用。候选包含普通任务，选样时保留成功案例。" };
}
export function reportMarkdown(report: ReturnType<typeof iterationReport>): string {
  const clean = (v: unknown) => String(v ?? "").replace(/[|\r\n]/g, " ");
  return `# Fenjue 迭代周报\n\n${report.since} 至 ${report.until}\n\n` +
    `任务：${report.summary.tasks}；执行轮次：${report.summary.turns}（含自动修正 ${report.summary.automaticRevisions} 轮）。\n\n` +
    `反馈：${JSON.stringify(report.summary.outcomes)}。已记录执行耗时：${report.summary.recordedExecutionMs} ms（${report.summary.timedTurns} 轮）。已记录 token：${report.summary.observedTokens ?? "未知"}。\n\n` +
    `专家审查：${report.summary.reviews} 次；已记录耗时：${report.summary.recordedReviewMs} ms；专家 token：${report.summary.reviewObservedTokens ?? "未知"}。总 token 包含主会话及专家。\n\n` +
    `| taskId | 请求预览 | 结果 | 待审核原因 |\n| --- | --- | --- | --- |\n` +
    report.candidates.map(c => `| ${clean(c.taskId)} | ${clean(c.preview)} | ${clean(c.outcome)} | ${clean(c.reasons.join("、"))} |`).join("\n") +
    `\n\n${report.note}\n\n下一步：选择普通成功案例和偏差案例；一次检验一个假设。使用 cases 标注分类，使用 tasks 补齐快照及独立验收。\n`;
}

export async function feedbackCommand(args: string[]): Promise<void> {
  const command = args.shift(), flags = new Map<string, string>();
  const allowed = command === "add" ? ["--dir", "--task", "--turn", "--outcome", "--cause", "--reviewer", "--reason", "--evidence"] :
    command === "list" ? ["--dir"] : command === "report" ? ["--dir", "--capture-dir", "--days", "--out"] : [];
  if (!allowed.length) throw new Error("用法：fenjue feedback list|add|report；详见 docs/continuous-iteration.md");
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (!allowed.includes(flag) || !value || value.startsWith("--") || flags.has(flag)) throw new Error(`无效 feedback 参数 ${flag}`);
    flags.set(flag, value);
  }
  const directory = resolve(flags.get("--dir") ?? ".fenjue");
  if (command === "add") {
    const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`需要 ${key}`); return value; };
    const feedback = await addFeedback(directory, { taskId: required("--task"), turnId: flags.get("--turn"),
      outcome: required("--outcome") as Outcome, cause: (flags.get("--cause") ?? "unknown") as FailureCause,
      reviewer: required("--reviewer"), reason: required("--reason"), evidence: flags.get("--evidence") });
    process.stdout.write(JSON.stringify(feedback, null, 2) + "\n"); return;
  }
  const tasks = await observedTasks(directory, flags.has("--capture-dir") ? resolve(flags.get("--capture-dir")!) : undefined);
  if (command === "list") { process.stdout.write(JSON.stringify({ directory, tasks }, null, 2) + "\n"); return; }
  const report = iterationReport(tasks, Number(flags.get("--days") ?? 7));
  if (flags.has("--out")) {
    const output = resolve(flags.get("--out")!);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, output.endsWith(".md") ? reportMarkdown(report) : JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    process.stdout.write(`迭代报告：${output}\n`);
  } else process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
