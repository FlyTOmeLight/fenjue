import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { record, type Route } from "./config.js";
import { redactCapture, type CaptureFrame, type CaptureItem } from "./capture.js";
import { fingerprint, type TaskState } from "./task-state.js";
import type { ExecutionCapture } from "./execution-capture.js";

export type NativeMode = "auto" | "shadow" | "manual";
export interface NativeState {
  version: 1; mode: NativeMode; taskId: string; task: TaskState;
  route: Route; suggestion?: Route; lastTurnId?: string; activeTurnId?: string;
  lastItemId?: string; policy: string;
  review?: { count: number; revisionTurns: string[] };
}
export interface NativeEvent {
  type: string; threadId?: string; taskId?: string; turnId?: string;
  mode?: NativeMode; route?: Route; reason?: string; [key: string]: unknown;
}

export function isCapacityError(error: unknown): boolean {
  return record(error) && error.codexErrorInfo === "serverOverloaded";
}

// State and outcomes share one owner. Only this owner writes private files;
// classifier inputs remain in memory, while persisted copies are redacted.
export class NativeRecords {
  readonly logPath: string;
  readonly capturePath?: string;
  private stateDirectory: string;
  private sequence = 0;
  private disabled = false;
  constructor(directory: string, captureDirectory: string | undefined, private secrets: string[],
    private warn: (message: string) => void, run = `${Date.now()}-${process.pid}`, private execution?: ExecutionCapture) {
    this.stateDirectory = join(directory, "native-state");
    mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    this.logPath = join(directory, `native-${run}.jsonl`);
    writeFileSync(this.logPath, "", { mode: 0o600, flag: "wx" });
    if (captureDirectory) {
      mkdirSync(captureDirectory, { recursive: true, mode: 0o700 });
      this.capturePath = join(captureDirectory, `capture-${run}.jsonl`);
      writeFileSync(this.capturePath, "", { mode: 0o600, flag: "wx" });
    }
  }
  load(threadId: string): NativeState | undefined {
    try {
      const state: unknown = JSON.parse(readFileSync(join(this.stateDirectory, fingerprint(threadId) + ".json"), "utf8"));
      if (!record(state) || state.version !== 1 || !["auto", "shadow", "manual"].includes(String(state.mode)) ||
          typeof state.taskId !== "string" || typeof state.policy !== "string" || !record(state.route) ||
          typeof state.route.model !== "string" || typeof state.route.effort !== "string" || !record(state.task) ||
          !Array.isArray(state.task.messages) || !state.task.messages.every(t => typeof t === "string") ||
          !Array.isArray(state.task.evidence) || !state.task.evidence.every(t => typeof t === "string") ||
          typeof state.task.incomplete !== "boolean" || (state.review !== undefined &&
            (!record(state.review) || !Number.isSafeInteger(state.review.count) || Number(state.review.count) < 0 ||
             !Array.isArray(state.review.revisionTurns) || !state.review.revisionTurns.every(t => typeof t === "string")))) throw new Error("invalid native state");
      return state as unknown as NativeState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn("无法恢复本地任务状态；本轮按未知上下文处理");
      return undefined;
    }
  }
  save(threadId: string, state: NativeState): void {
    this.write(() => {
      const path = join(this.stateDirectory, fingerprint(threadId) + ".json"), temp = path + ".tmp";
      writeFileSync(temp, this.serialize(state), { mode: 0o600 }); renameSync(temp, path);
    });
  }
  event(event: NativeEvent): void {
    this.write(() => appendFileSync(this.logPath, this.serialize({ time: new Date().toISOString(), ...event }) + "\n"));
    if (["completed", "retry-failed"].includes(event.type) && event.threadId && event.taskId && event.turnId) {
      this.execution?.complete(event.threadId, event.taskId, event.turnId, String(event.status));
    }
  }
  async prepareExecution(threadId: string, state: NativeState, cwd: string | undefined, prompt: string, signal: AbortSignal): Promise<void> {
    await this.execution?.prepare(threadId, state.taskId, cwd, prompt, signal);
  }
  discardExecution(threadId: string, taskId: string): void { this.execution?.discard(threadId, taskId); }
  retryExecution(threadId: string, taskId: string, previousTurnId: string, turnId?: string): void {
    this.execution?.retry(threadId, taskId, previousTurnId, turnId);
  }
  markReview(threadId: string, taskId: string): void { this.execution?.markReview(threadId, taskId); }
  capture(threadId: string, state: NativeState, turnId: string, items: CaptureItem[], context?: TaskState): void {
    this.execution?.observe(threadId, state.taskId, turnId, items, state.task.incomplete);
    if (!this.capturePath || !items.length) return;
    const frame: CaptureFrame & { taskId: string; turnId: string } = {
      version: 1, time: new Date().toISOString(), thread: fingerprint(threadId), identity: "provided",
      request: ++this.sequence, change: "append", items, taskId: state.taskId, turnId, context,
    };
    this.write(() => appendFileSync(this.capturePath!, this.serialize(frame) + "\n"));
  }
  private serialize(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? redactCapture(item, this.secrets) : item);
  }
  private write(action: () => void): void {
    if (this.disabled) return;
    try { action(); }
    catch { this.disabled = true; this.warn("原生路由记录写入失败，已停止记录；Codex 会话继续"); }
  }
}
export function emptyNativeState(mode: NativeMode, route: Route, policy: string): NativeState {
  return { version: 1, mode, route, policy, taskId: randomUUID(), task: { messages: [], evidence: [], incomplete: false } };
}
