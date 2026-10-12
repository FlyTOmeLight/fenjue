import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { record, readConfig, type Config } from "./config.js";
import { QUESTIONS } from "./classification.js";
import { parseEvaluationCases } from "./evaluation-cases.js";
import type { CaptureFrame, CaptureItem } from "./capture.js";
import { modelReviewedCase } from "./judge.js";
import { evaluateNativeCase, parseNativeEvaluationCases, type NativeEvaluationCase } from "./native-evaluation.js";

export async function captureFrames(path: string): Promise<CaptureFrame[]> {
  const text = await readFile(path, "utf8");
  // A live writer or interrupted process may leave an unfinished last record.
  const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
  return lines.map(line => {
    const frame: unknown = JSON.parse(line);
    if (!record(frame) || frame.version !== 1 || typeof frame.thread !== "string" || typeof frame.time !== "string" ||
        !["append", "reset"].includes(String(frame.change)) || !["provided", "history"].includes(String(frame.identity)) ||
        !Number.isSafeInteger(frame.request) || !Array.isArray(frame.items) || frame.items.some(item => !record(item) ||
          !["user", "evidence"].includes(String(item.kind)) || typeof item.text !== "string" ||
          (item.incomplete !== undefined && typeof item.incomplete !== "boolean")) ||
        (frame.context !== undefined && (!record(frame.context) || !Array.isArray(frame.context.messages) ||
          !frame.context.messages.every(t => typeof t === "string") || !Array.isArray(frame.context.evidence) ||
          !frame.context.evidence.every(t => typeof t === "string") || typeof frame.context.incomplete !== "boolean"))) throw new Error("无效的本地任务采集记录");
    return frame as unknown as CaptureFrame;
  });
}

export async function draftCase(file: string, thread: string) {
  const frames = (await captureFrames(file)).filter(frame => frame.thread === thread);
  if (!frames.length) throw new Error("采集文件中找不到该 thread；请先运行 cases list");
  const warnings: string[] = [];
  if (frames.some(f => f.change === "reset")) warnings.push("存在上下文重写或压缩：草稿保留各段输入，审核时需消除重复并补齐目标，不能直接视为连续完整历史。");
  if (frames.some(f => f.identity === "history")) warnings.push("请求未提供会话标识，按首条用户历史分组；请核对是否完整。");
  if (frames.some(f => f.items.some(i => i.incomplete))) warnings.push("包含图片或其他非文本输入；请补充足够的文字上下文，否则不导出该案例。");
  if (frames.some(f => f.context)) warnings.push("这是恢复会话的片段：review.contexts 保存恢复时的目标与证据，请与同 thread 的较早采集合并并核对顺序后标注。");
  const turns: { text: string; evidence?: string; features: null; expected: null }[] = [];
  let evidence: string[] = [];
  for (const frame of frames) {
    for (const item of frame.items) {
      if (item.kind === "evidence") evidence.push(item.text);
      else {
        turns.push({ text: item.text, ...(evidence.length ? { evidence: evidence.join("\n\n") } : {}), features: null, expected: null });
        evidence = [];
      }
    }
  }
  if (!turns.length) throw new Error("该片段只有工具结果，没有用户任务");
  return { version: 1, review: { reviewer: "", approved: false, warnings, contexts: frames.flatMap(f => f.context ? [f.context] : []) },
    instructions: "先核对脱敏与上下文，再标注各轮五项 features 和 expected.role/effort；不要参照路由预测。完成后填写 reviewer，并将 approved 改为 true。这是人工审核声明，不会由分类器自动填写。",
    choices: { features: Object.fromEntries(Object.entries(QUESTIONS).map(([key, q]) => [key, q.criteria])),
      expected: { role: ["fast", "balanced", "deep"], effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] } },
    outcome: { quality: "unknown", trailingEvidence: evidence },
    case: { id: `daily-${basename(file, ".jsonl").replace(/^capture-/, "")}-${thread.slice(0, 12)}`,
      source: { kind: "daily", thread, capture: basename(file) }, turns } };
}

export async function exportCases(paths: string[], out: string, nativeConfig?: Config): Promise<number> {
  const cases: unknown[] = [], threads = new Set<string>();
  for (const path of paths) {
    const draft: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!record(draft) || draft.version !== 1 || !record(draft.review) || !record(draft.case) || !record(draft.case.source)) {
      throw new Error(`${basename(path)} 尚未完成人工审核：请填写 review.reviewer 和 review.approved`);
    }
    const model = modelReviewedCase(draft);
    const human = draft.review.approved === true && typeof draft.review.reviewer === "string" && draft.review.reviewer.trim();
    if (!human && !model) throw new Error(`${basename(path)} 尚未完成人工审核或模型审核`);
    const thread = String(draft.case.source.thread);
    if (threads.has(thread)) throw new Error("同一会话出现多份草稿，请先合并；不要将同一会话拆到不同数据组");
    threads.add(thread);
    cases.push({ ...draft.case, source: { ...draft.case.source, reviewer: human ? draft.review.reviewer : `codex:${model!.model}`,
      reviewed: true, reviewKind: human ? "human" : "model", ...(model ? { modelReview: model } : {}) } });
  }
  const validated = nativeConfig ? await nativeCases(cases, nativeConfig) : parseEvaluationCases(cases);
  await privateJSON(out, validated);
  return validated.length;
}

// Routes are deterministic policy projections of independently reviewed features.
// They are not judge evidence that a particular model is required for quality.
async function nativeCases(cases: unknown[], config: Config): Promise<NativeEvaluationCase[]> {
  if (!config.semantic) throw new Error("原生案例导出需要 semantic 配置");
  const parsed = parseEvaluationCases(cases);
  const scenarios = parseNativeEvaluationCases(parsed.map(c => {
    if (c.turns[0]!.evidence) throw new Error("首轮之前已有证据；请先补齐会话起点，不能直接导出原生回放");
    return { id: c.id, group: c.source!.thread, split: "calibration", source: { ...c.source, routeLabels: "declared-policy" },
      turns: c.turns.map((t, index) => {
        const constraint = (t as any).constraints;
        if (!["independent", "coupled"].includes(String(constraint))) throw new Error("原生导出需要每轮 constraints 标签");
        const initial = config.routes[config.semantic!.roles.balanced]!;
        // Daily drafts attach evidence BEFORE a request; native fixtures attach
        // simulated output AFTER a turn. Move it to the preceding native turn.
        const followingEvidence = c.turns[index + 1]?.evidence;
        return { text: t.text, ...(followingEvidence ? { evidence: followingEvidence } : {}), features: t.features,
          constraints: constraint, allowed: { baseline: [initial], constraints: [initial] } };
      }) };
  }));
  for (const scenario of scenarios) {
    for (const policy of ["baseline", "constraints"] as const) {
      const strategy = { ...config, native: { ...config.native, expertPolicy: policy === "constraints" ? "constraints" as const : undefined } };
      const rows = await evaluateNativeCase(strategy, scenario, undefined, new AbortController().signal);
      rows.forEach((row, i) => {
        scenario.turns[i]!.allowed[policy] = [row.route];
        // Include holds caused by uncertain references; live classifiers may still fail this expectation.
        scenario.turns[i]!.reasons = ["classified", "continuation", "low-confidence", "prefix-rule"];
      });
    }
  }
  return parseNativeEvaluationCases(scenarios);
}

async function privateJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

export async function casesCommand(args: string[]): Promise<void> {
  const command = args.shift();
  if (!["list", "draft", "export"].includes(String(command))) throw new Error("用法：fenjue cases list [--dir 目录] | draft --file 采集文件 --thread ID --out 草稿.json | export --draft 已审核草稿.json [--draft 更多草稿.json] --out 数据集.json");
  const flags = new Map<string, string>(), drafts: string[] = [];
  const allowed = command === "list" ? ["--dir"] : command === "draft" ? ["--file", "--thread", "--out"] : ["--draft", "--out", "--format", "--config"];
  while (args.length) {
    const key = args.shift()!, value = args.shift();
    if (!allowed.includes(key) || !value || value.startsWith("--") || (key !== "--draft" && flags.has(key))) throw new Error(`无效 cases 参数 ${key}`);
    if (key === "--draft") drafts.push(value); else flags.set(key, value);
  }
  if (command === "list") {
    const dir = resolve(flags.get("--dir") ?? ".fenjue/daily");
    const names = await readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const rows = [];
    for (const name of names.filter(n => /^capture-\d+-\d+\.jsonl$/.test(n)).sort()) {
      const file = resolve(dir, name), frames = await captureFrames(file);
      for (const thread of new Set(frames.map(f => f.thread))) {
        const selected = frames.filter(f => f.thread === thread), items: CaptureItem[] = selected.flatMap(f => f.items);
        rows.push({ file, thread, firstSeen: selected[0]!.time, lastSeen: selected.at(-1)!.time,
          userTurns: items.filter(i => i.kind === "user").length, evidenceItems: items.filter(i => i.kind === "evidence").length,
          needsContextReview: selected.some(f => f.change === "reset" || f.identity === "history" || f.context) || items.some(i => i.incomplete),
          preview: items.find(i => i.kind === "user")?.text.slice(0, 100) });
      }
    }
    process.stdout.write(JSON.stringify({ directory: dir, conversations: rows }, null, 2) + "\n");
    return;
  }
  const out = flags.get("--out");
  if (!out) throw new Error("请指定 --out；已有文件不会覆盖");
  if (command === "draft") {
    const file = flags.get("--file"), thread = flags.get("--thread");
    if (!file || !thread) throw new Error("draft 需要 --file 和 --thread");
    await privateJSON(out, await draftCase(file, thread));
    process.stdout.write(`待标注草稿：${resolve(out)}\n`);
  } else {
    if (!drafts.length) throw new Error("export 需要至少一个 --draft");
    const format = flags.get("--format") ?? "legacy";
    if (!["legacy", "native"].includes(format) || (format === "legacy" && flags.has("--config"))) throw new Error("--format 可用 legacy/native；--config 仅用于 native");
    const count = await exportCases(drafts, out, format === "native" ? await readConfig(resolve(flags.get("--config") ?? "fenjue.config.json")) : undefined);
    process.stdout.write(`已导出 ${count} 个经审核的真实案例：${resolve(out)}\n`);
  }
}
