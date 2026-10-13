import { open, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "./config.js";
import type { Event } from "./proxy.js";
import { isCapacityError, type NativeEvent } from "./native-records.js";

function nativeFailureText(error: unknown): string {
  if (isCapacityError(error)) return "模型容量不足";
  return record(error) && typeof error.message === "string" ? error.message : "未知错误";
}

export class NativeRouteStatus {
  private latest?: NativeEvent;
  private reason?: string;
  private suggestion?: string;
  private reported?: string;
  time?: string;
  update(event: NativeEvent): boolean {
    if (["usage", "evidence", "final-answer", "planned", "classification-call", "classification-started", "demand-shadow"].includes(event.type)) return false;
    if (!["bound", "classifying", "submitting"].includes(event.type) && this.latest?.threadId && event.threadId !== this.latest.threadId) return false;
    this.latest = event; this.time = typeof event.time === "string" ? event.time : undefined;
    if (event.type === "bound" || event.type === "accepted") this.reported = undefined;
    if (event.type === "accepted") {
      this.reason = event.reason;
      this.suggestion = record(event.suggestion) ? `${event.suggestion.model} · ${event.suggestion.effort}` : undefined;
    }
    if (event.type === "rerouted" && typeof event.toModel === "string") this.reported = event.toModel;
    return true;
  }
  line(): string {
    const e = this.latest;
    if (!e) return "焚诀 | 等待原生会话";
    const mode = { auto: "自动", manual: "手动", shadow: "观察" }[e.mode ?? "auto"];
    const reviewPhase: Record<string, string> = { "review-started": `专家审查中 ${((e.reviewRoute as any)?.model ?? "")}`,
      "review-finished": e.status === "completed" ? "专家审查完成" : "专家审查停止", "review-revision": "核对审查意见",
      "review-skipped": "跳过专家审查", "review-error": "专家审查失败" };
    const failed = (e.type === "completed" && e.status === "failed") || e.type === "retry-failed";
    const phase = failed ? e.previousError ? `重试失败：首次 ${nativeFailureText(e.previousError)}；重试 ${nativeFailureText(e.error)}` :
      `轮次失败：${nativeFailureText(e.error)}` : e.type === "retrying" ? `${e.fromModel} 容量不足，正在改用 ${e.toModel} 重试（1/1）` :
      reviewPhase[e.type] ?? (e.type === "classifying" ? "评估中" : e.type === "accepted" ? "已提交" :
      e.type === "completed" ? ({ completed: "轮次完成", interrupted: "已打断", failed: "轮次失败" }[String(e.status)] ?? String(e.status)) :
      e.type === "mode" ? "下轮生效" : e.reason ?? e.type);
    const route = e.route ? `${e.route.model} · ${e.route.effort}` : "等待会话";
    const reason = !failed && e.type !== "retrying" && this.reason ? ` (${this.reason === "capacity-retry" ? "容量重试 1/1" : this.reason})` : "";
    return displayText(`焚诀 ${mode}·均衡 | ${route} | ${phase}${reason}` +
      (e.mode === "shadow" && this.suggestion ? ` | 建议 ${this.suggestion}` : "") +
      (this.reported ? ` | 服务端改为 ${this.reported}` : ""));
  }
}

function displayText(text: string): string {
  return text.replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
}

// One title describes the most recently started request. Older concurrent
// responses must not make it appear that the selected model switched back.
export class RouteStatus {
  private selected?: Event;
  private latest?: Event;
  time?: string;

  update(event: Event, time?: string): boolean {
    if (event.event === "request") {
      if (this.selected && event.request <= this.selected.request) return false;
      this.selected = event;
    } else if (event.request !== this.selected?.request) return false;
    this.latest = event;
    this.time = time;
    return true;
  }

  line(compact = false): string {
    const selected = this.selected, latest = this.latest;
    if (!selected || !latest) return "焚诀 | 等待模型请求";
    const state = latest.event === "request" ? "已发出" : latest.event === "completed" ?
      `HTTP ${latest.status ?? "未知"} · 传输结束` : latest.reason === "cancelled" ? "已取消" : "连接失败或流中断";
    const semantic = selected.mode === "shadow" ? ` | 观察建议 ${selected.suggestedModel ?? "未知"} · ${selected.suggestedEffort ?? "未知"} (${selected.classificationReason ?? "未知"})` :
      selected.mode === "auto" ? ` | 自动 (${selected.classificationReason ?? selected.reason ?? "未知"})` : "";
    if (compact) return displayText(`焚诀 | 请求 ${selected.model ?? "未知"} · ${selected.effort || "未指定强度"}` +
      semantic + ` | ${selected.route ?? "手动"} | ${state}` + (latest.servedModel ? ` | 上游 ${latest.servedModel}` : ""));
    const elapsed = latest.elapsedMs === undefined ? "" : ` · ${(latest.elapsedMs / 1000).toFixed(1)}s`;
    return displayText(`焚诀 | 请求 ${selected.model ?? "未知"} · ${selected.effort || "未指定强度"}` +
      ` | #${selected.request} ${state}${elapsed} | 路线 ${selected.route ?? "手动"}（${selected.reason ?? "未知"}）` +
      semantic + ` | 上游报告 ${latest.servedModel || "未提供"}`);
  }
}

export function createTitleDisplay(write: (text: string) => void) {
  const status = new RouteStatus();
  let closed = false;
  const render = () => write(`\x1b]0;${Array.from(status.line()).slice(0, 240).join("")}\x07`);
  render();
  return {
    onEvent(event: Event) { if (!closed && status.update(event)) render(); },
    close() {
      if (closed) return;
      closed = true;
      // Clear the managed title; the shell/terminal owns its next title.
      write("\x1b]0;\x07");
    },
  };
}

export async function latestLog(logDir = ".fenjue"): Promise<string> {
  const files = (await readdir(logDir)).filter(f => /^(route|native)-\d+-\d+\.jsonl$/.test(f));
  files.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  if (!files[0]) throw new Error(`没有路由记录：${logDir}；请先通过焚诀启动 Codex，或用 --log 指定文件`);
  return resolve(logDir, files[0]);
}

function parseEvent(line: string): Event & { time?: string } {
  const value: unknown = JSON.parse(line);
  if (!record(value) || !["request", "completed", "failed"].includes(String(value.event)) ||
      !Number.isSafeInteger(value.request) || Number(value.request) < 1) throw new Error("无效的焚诀路由记录");
  for (const key of ["time", "model", "effort", "route", "reason", "servedModel", "mode", "suggestedModel", "suggestedEffort", "classificationReason"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`路由记录 ${key} 必须是字符串`);
  }
  for (const key of ["status", "elapsedMs"]) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw new Error(`路由记录 ${key} 必须是数值`);
  }
  return value as unknown as Event & { time?: string };
}

export async function showStatus(path: string, options: {
  watch?: boolean; signal?: AbortSignal; write: (text: string) => void;
}): Promise<void> {
  const file = await open(path, "r");
  const status = new RouteStatus(), decoder = new StringDecoder("utf8"), buffer = Buffer.alloc(64 * 1024);
  const nativeStatus = new NativeRouteStatus();
  let native = false;
  let pending = "", first = true;
  try {
    options.write(`路由记录：${displayText(resolve(path))}\n`);
    do {
      // Read only newly appended bytes, retaining partial UTF-8 and JSON lines.
      for (;;) {
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) break;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const value: unknown = JSON.parse(line);
          if (record(value) && typeof value.type === "string") {
            native = true;
            if (nativeStatus.update(value as NativeEvent) && !first && options.watch) options.write(`${displayText(nativeStatus.time ?? "")} ${nativeStatus.line()}\n`);
            continue;
          }
          const event = parseEvent(line);
          if (status.update(event, event.time)) {
            if (!first && options.watch) options.write(`${displayText(status.time ?? "")} ${status.line()}\n`);
          }
        }
      }
      if (first) options.write(native ? `${displayText(nativeStatus.time ?? "")} ${nativeStatus.line()}\n` : `${displayText(status.time ?? "")} ${status.line()}\n`);
      first = false;
      if (!options.watch || options.signal?.aborted) break;
      await delay(250, undefined, { signal: options.signal });
    } while (!options.signal?.aborted);
  } catch (error) {
    if (!options.signal?.aborted) throw error;
  } finally { await file.close(); }
}
