import { readFileSync, writeFileSync, renameSync, rmSync, appendFileSync } from "node:fs";
import { mkdir, readFile, rm, readdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import type { ExecutionCaptureConfig } from "./config.js";
import { record } from "./config.js";
import { redactCapture, type CaptureItem } from "./capture.js";
import { fingerprint } from "./task-state.js";
import { copySnapshot, digest, snapshotFiles, saveJSON, parseExecutionSuite, type ExecutionSuite } from "./task-evaluation.js";

interface AcceptancePlan { firstPromptDigest: string; registeredAt: string; verifierDigest: string }
export interface ExecutionCaptureManifest {
  version: 1; id: string; thread: string; taskId: string; group: string;
  startedAt: string; project: string; paths: string[]; snapshotDigest: string;
  files: Record<string, string>; prompts: string[]; turnIds: string[];
  outcomes: Record<string, string>; contextComplete: boolean; warnings: string[];
  acceptancePlan?: AcceptancePlan;
}
const promptDigest = (text: string) => fingerprint(text.trim());
const bundleName = (thread: string, taskId: string) => `daily-${fingerprint([thread, taskId]).slice(0, 24)}`;
const planName = (project: string, prompt: string) => fingerprint([project, promptDigest(prompt)]);
const manifestPath = (directory: string) => join(directory, "capture.json");

// Local code stays byte-identical for replay. Only explicitly selected projects
// and paths are copied. Routing and model output cannot approve these cases.
export class ExecutionCapture {
  private failed = new Set<string>();
  constructor(private config: ExecutionCaptureConfig, private secrets: string[], private warn: (message: string) => void) {}
  async prepare(threadId: string, taskId: string, cwd: string | undefined, prompt: string, signal: AbortSignal): Promise<void> {
    if (!cwd) return;
    const project = this.config.projects.find(p => resolve(p.directory) === resolve(cwd));
    if (!project) return;
    const directory = this.directory(threadId, taskId);
    let created = false;
    try {
      // Never replace the starting point on resume, retry or later turns.
      try { readFileSync(manifestPath(directory)); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      signal.throwIfAborted();
      await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      created = true;
      const files = await snapshotFiles(project.directory, project.paths);
      if (!Object.keys(files).length) throw new Error("所选路径没有可回放文件");
      await copySnapshot(project.directory, join(directory, "snapshot"), files);
      signal.throwIfAborted();
      const capture: ExecutionCaptureManifest = { version: 1, id: bundleName(threadId, taskId), thread: fingerprint(threadId), taskId,
        group: `project-${fingerprint(await realpath(cwd)).slice(0, 16)}`, startedAt: new Date().toISOString(), project: cwd,
        paths: project.paths, snapshotDigest: digest(files), files, prompts: [], turnIds: [], outcomes: {}, contextComplete: true, warnings: [] };
      const plan = join(this.config.directory, "plans", planName(resolve(cwd), prompt));
      let registered: AcceptancePlan | undefined;
      try { registered = JSON.parse(await readFile(join(plan, "plan.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (registered) {
        const verifier = await readFile(join(plan, "acceptance.mjs"));
        if (registered.firstPromptDigest !== promptDigest(prompt) || registered.verifierDigest !== fingerprint(verifier.toString("utf8")) ||
            typeof registered.registeredAt !== "string" || registered.registeredAt > capture.startedAt) throw new Error("预登记验收已变化");
        await writeFile(join(directory, "acceptance.mjs"), verifier, { mode: 0o600, flag: "wx" });
        capture.acceptancePlan = registered;
      }
      signal.throwIfAborted();
      await saveJSON(manifestPath(directory), capture);
      signal.throwIfAborted();
    } catch (error) {
      if (created) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (!signal.aborted) this.warn(`执行快照未保存：${error instanceof Error ? error.message : String(error)}；日常对话采集继续`);
    }
  }
  observe(threadId: string, taskId: string, turnId: string, items: CaptureItem[], incomplete: boolean): void {
    this.update(threadId, taskId, (capture, directory) => {
      if (incomplete) this.mark(capture, "原生任务上下文不完整，不能直接回放");
      for (const item of items) {
        const text = redactCapture(item.text, this.secrets);
        if (item.kind === "user") {
          if (capture.turnIds.includes(turnId)) this.mark(capture, "同一执行轮内有补充输入，不能当作顺序多轮任务回放");
          if (item.incomplete) this.mark(capture, "包含未保存的非文本输入");
          if (text !== item.text) this.mark(capture, "用户输入已脱敏，回放语义需要重建");
          capture.prompts.push(text); capture.turnIds.push(turnId);
        }
        appendFileSync(join(directory, "items.jsonl"), JSON.stringify({ turnId, ...item, text }) + "\n", { mode: 0o600 });
      }
    });
  }
  complete(threadId: string, taskId: string, turnId: string, status: string): void {
    this.update(threadId, taskId, capture => { capture.outcomes[turnId] = status; });
  }
  retry(threadId: string, taskId: string, previousTurnId: string, turnId?: string): void {
    this.update(threadId, taskId, capture => {
      const index = capture.turnIds.indexOf(previousTurnId);
      if (index < 0) return;
      delete capture.outcomes[previousTurnId];
      if (turnId) capture.turnIds[index] = turnId;
    });
  }
  markReview(threadId: string, taskId: string): void {
    this.update(threadId, taskId, capture => this.mark(capture, "任务包含自动专家审查和修正，需重建审查策略后评测，不能直接顺序回放"));
  }
  discard(threadId: string, taskId: string): void {
    const directory = this.directory(threadId, taskId);
    try {
      const capture = JSON.parse(readFileSync(manifestPath(directory), "utf8")) as ExecutionCaptureManifest;
      if (!capture.prompts.length) rmSync(directory, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn("无法清理尚未执行的快照"); }
  }
  private mark(capture: ExecutionCaptureManifest, message: string) {
    capture.contextComplete = false;
    if (!capture.warnings.includes(message)) capture.warnings.push(message);
  }
  private directory(threadId: string, taskId: string) { return join(this.config.directory, bundleName(threadId, taskId)); }
  private update(threadId: string, taskId: string, action: (capture: ExecutionCaptureManifest, directory: string) => void) {
    const directory = this.directory(threadId, taskId), path = manifestPath(directory);
    let capture: ExecutionCaptureManifest;
    try {
      capture = JSON.parse(readFileSync(path, "utf8")) as ExecutionCaptureManifest;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn("执行 case 记录不可读；Codex 会话继续"); return; }
    try {
      if (this.failed.has(directory)) this.mark(capture, "执行记录曾写入失败，不能直接回放");
      action(capture, directory);
      writeFileSync(path + ".tmp", JSON.stringify(capture, null, 2) + "\n", { mode: 0o600 }); renameSync(path + ".tmp", path);
    } catch {
      this.failed.add(directory);
      this.mark(capture, "执行记录曾写入失败，不能直接回放");
      // Preserve the failure across restarts when metadata remains writable.
      try { writeFileSync(path, JSON.stringify(capture, null, 2) + "\n", { mode: 0o600 }); } catch { /* disk failure is reported below */ }
      this.warn("执行 case 记录写入失败，不能作为完整回放；Codex 会话继续");
    }
  }
}

export async function registerAcceptance(directory: string, project: string, promptFile: string, verifierFile: string) {
  project = resolve(project);
  const prompt = await readFile(promptFile, "utf8"), verifier = await readFile(verifierFile, "utf8");
  if (!prompt.trim() || !verifier.trim()) throw new Error("首条任务和验收脚本不能为空");
  const plan = join(resolve(directory), "plans", planName(project, prompt));
  await mkdir(dirname(plan), { recursive: true, mode: 0o700 }); await mkdir(plan, { mode: 0o700 });
  try {
    const metadata: AcceptancePlan = { firstPromptDigest: promptDigest(prompt), registeredAt: new Date().toISOString(), verifierDigest: fingerprint(verifier) };
    await writeFile(join(plan, "acceptance.mjs"), verifier, { mode: 0o600, flag: "wx" });
    await saveJSON(join(plan, "plan.json"), metadata);
  } catch (error) { await rm(plan, { recursive: true, force: true }); throw error; }
  return plan;
}

export async function executionDraft(directory: string) {
  directory = resolve(directory);
  const capture = await readExecutionCapture(directory);
  return { version: 1, review: { reviewer: "", approved: false }, source: { directory, snapshotDigest: capture.snapshotDigest },
    warnings: [...capture.warnings, ...(capture.acceptancePlan ? [] : ["验收尚未预登记；补写的验收只能用于 calibration"])],
    task: { id: capture.id, category: null, group: capture.group, split: "calibration", origin: "daily", snapshot: "snapshot",
      prompts: capture.prompts, acceptance: capture.acceptancePlan ? { verifier: join(directory, "acceptance.mjs"), timeoutMs: 30000 } : null,
      limits: { wallMs: 600000, toolCalls: 60, tokens: 1500000 } } };
}
async function readExecutionCapture(directory: string): Promise<ExecutionCaptureManifest> {
  const value: unknown = JSON.parse(await readFile(manifestPath(directory), "utf8"));
  if (!record(value) || value.version !== 1 || typeof value.id !== "string" || !/^daily-[a-f0-9]{24}$/.test(value.id) ||
      typeof value.thread !== "string" || typeof value.group !== "string" || typeof value.snapshotDigest !== "string" ||
      typeof value.taskId !== "string" || typeof value.startedAt !== "string" || typeof value.project !== "string" ||
      !record(value.files) || !Object.values(value.files).every(v => typeof v === "string") ||
      !Array.isArray(value.prompts) || !value.prompts.every(p => typeof p === "string") ||
      !Array.isArray(value.turnIds) || !value.turnIds.every(v => typeof v === "string") || value.turnIds.length !== value.prompts.length ||
      !record(value.outcomes) || !Object.values(value.outcomes).every(v => typeof v === "string") ||
      typeof value.contextComplete !== "boolean" || !Array.isArray(value.warnings) || !value.warnings.every(v => typeof v === "string") ||
      (value.acceptancePlan !== undefined && (!record(value.acceptancePlan) ||
        typeof value.acceptancePlan.firstPromptDigest !== "string" || typeof value.acceptancePlan.registeredAt !== "string" ||
        typeof value.acceptancePlan.verifierDigest !== "string"))) throw new Error("无效执行快照记录");
  return value as unknown as ExecutionCaptureManifest;
}
export async function exportExecutionCases(drafts: string[], output: string, strategies: ExecutionSuite["strategies"]) {
  const prepared = [], threads = new Map<string, string>();
  for (const path of drafts) {
    const draft: any = JSON.parse(await readFile(path, "utf8"));
    if (draft.version !== 1 || draft.review?.approved !== true || typeof draft.review?.reviewer !== "string" || !draft.review.reviewer.trim() ||
        !draft.source?.directory || !draft.task) throw new Error("执行 case 尚未完成人工审核");
    const directory = resolve(dirname(path), draft.source.directory), capture = await readExecutionCapture(directory);
    if (threads.has(capture.thread) && threads.get(capture.thread) !== draft.task.split) throw new Error("同一会话不能跨校准集和冻结集");
    threads.set(capture.thread, draft.task.split);
    if (!capture.contextComplete || !capture.prompts.length || capture.turnIds.some(id => !capture.outcomes[id])) throw new Error("任务上下文不完整或仍在执行，不能导出");
    const files = await snapshotFiles(join(directory, "snapshot"));
    if (digest(files) !== capture.snapshotDigest || digest(capture.files) !== capture.snapshotDigest ||
        draft.source.snapshotDigest !== capture.snapshotDigest) throw new Error("起始快照已变化");
    if (draft.task.id !== capture.id || draft.task.group !== capture.group || draft.task.origin !== "daily" ||
        JSON.stringify(draft.task.prompts) !== JSON.stringify(capture.prompts)) throw new Error("来源、项目分组或用户输入已变化，不能标为原始日常回放");
    const acceptance = draft.task.acceptance;
    if (!acceptance || typeof acceptance.verifier !== "string") throw new Error("需要独立 Node 验收脚本");
    const verifier = await readFile(resolve(dirname(path), acceptance.verifier), "utf8");
    if (capture.acceptancePlan) {
      if (fingerprint(verifier) !== capture.acceptancePlan.verifierDigest ||
          promptDigest(capture.prompts[0]!) !== capture.acceptancePlan.firstPromptDigest ||
          capture.acceptancePlan.registeredAt > capture.startedAt) throw new Error("预登记验收已变化，不能用于原始执行对比");
    } else if (draft.task.split !== "calibration") throw new Error("事后补写的验收只能进入 calibration");
    if (draft.task.split === "holdout" && capture.prompts.length !== 1) throw new Error("冻结验证集首版只接受单条预登记任务；多轮反馈需先进入 calibration");
    prepared.push({ capture, directory, verifier, reviewer: draft.review.reviewer, task: { ...draft.task,
      snapshot: `snapshots/${capture.id}`, acceptance: { argv: ["node", `{suite}/acceptance/${capture.id}.mjs`], timeoutMs: acceptance.timeoutMs } } });
  }
  const suite = parseExecutionSuite({ version: 1, strategies, tasks: prepared.map(p => p.task) });
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await mkdir(output, { mode: 0o700 });
  try {
    await mkdir(join(output, "acceptance"), { mode: 0o700 });
    for (const p of prepared) {
      await copySnapshot(join(p.directory, "snapshot"), join(output, p.task.snapshot), p.capture.files);
      await writeFile(join(output, "acceptance", `${p.capture.id}.mjs`), p.verifier, { mode: 0o600, flag: "wx" });
    }
    await saveJSON(join(output, "suite.json"), suite);
    await saveJSON(join(output, "provenance.json"), prepared.map(p => ({ id: p.capture.id, thread: p.capture.thread,
      group: p.capture.group, snapshotDigest: p.capture.snapshotDigest, reviewer: p.reviewer,
      acceptanceTiming: p.capture.acceptancePlan ? "prospective" : "retrospective", registeredAt: p.capture.acceptancePlan?.registeredAt })));
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  return suite.tasks.length;
}

export async function tasksCommand(args: string[]) {
  const command = args.shift(), flags = new Map<string, string>(), drafts: string[] = [];
  const options: Record<string, string[]> = { list: ["--dir"], register: ["--dir", "--project", "--prompt", "--verifier"],
    draft: ["--case", "--out"], export: ["--draft", "--out", "--strategies"] };
  if (!command || !options[command]) throw new Error("用法：fenjue tasks list|register|draft|export；详见 docs/task-evaluation.md");
  while (args.length) {
    const key = args.shift()!, value = args.shift();
    if (!options[command]!.includes(key) || !value || value.startsWith("--") || (flags.has(key) && key !== "--draft")) throw new Error(`无效 tasks 参数 ${key}`);
    if (key === "--draft") drafts.push(value); else flags.set(key, value);
  }
  const requireFlag = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`需要 ${key}`); return value; };
  const directory = resolve(flags.get("--dir") ?? ".fenjue/execution-cases");
  if (command === "register") {
    const plan = await registerAcceptance(directory, requireFlag("--project"), requireFlag("--prompt"), requireFlag("--verifier"));
    process.stdout.write(`已预登记验收：${plan}\n`);
  } else if (command === "list") {
    const names = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const cases = [];
    for (const name of names.filter(n => /^daily-[a-f0-9]{24}$/.test(n)).sort()) {
      const path = join(directory, name), capture = await readExecutionCapture(path);
      if (!capture.prompts.length) continue;
      cases.push({ directory: path, id: capture.id, group: capture.group, turns: capture.prompts.length,
        complete: capture.turnIds.every(id => !!capture.outcomes[id]), contextComplete: capture.contextComplete,
        acceptanceTiming: capture.acceptancePlan ? "prospective" : "not-registered", preview: capture.prompts[0]!.slice(0, 100) });
    }
    process.stdout.write(JSON.stringify({ directory, cases }, null, 2) + "\n");
  } else if (command === "draft") {
    const out = resolve(requireFlag("--out")); await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    await writeFile(out, JSON.stringify(await executionDraft(requireFlag("--case")), null, 2) + "\n", { mode: 0o600, flag: "wx" });
    process.stdout.write(`待审核执行 case：${out}\n`);
  } else {
    const strategies = flags.has("--strategies") ? JSON.parse(await readFile(flags.get("--strategies")!, "utf8")) :
      [{ id: "fixed-sol-medium", kind: "fixed", route: { model: "gpt-6.1-sol", effort: "medium" } },
        { id: "sol-auto", kind: "sol-auto" }, { id: "sol-astra-auto", kind: "expert-auto", expertModel: "gpt-6-astra" }];
    if (!drafts.length) throw new Error("需要至少一个 --draft");
    const count = await exportExecutionCases(drafts, requireFlag("--out"), strategies);
    process.stdout.write(`已导出 ${count} 个经审核的执行任务：${resolve(requireFlag("--out"))}/suite.json\n`);
  }
}
