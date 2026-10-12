import { randomUUID } from "node:crypto";
import { record, type NativeReviewConfig } from "./config.js";
import type { NativeMessage } from "./native-session.js";
import { ARCHITECT_INSTRUCTIONS, completedWork } from "./architect-review.js";

interface RunningReview {
  items: any[]; turnId?: string; tokens: number | null; toolCalls: number;
  finish: (turn: any) => void; controller: AbortController; config: NativeReviewConfig;
}

// Owns private RPCs, read-only threads, permission requests and cancellation.
// Expert messages never reach the main TUI or the user-task capture pipeline.
export class NativeReviewer {
  private pending = new Map<string, { method: string; resolve: (value: any) => void; reject: (error: Error) => void }>();
  private threads = new Set<string>();
  private starts = new Set<string>();
  private running = new Map<string, RunningReview>();
  constructor(private send: (message: NativeMessage) => void) {}

  fromServer(message: NativeMessage): boolean {
    if (typeof message.id === "string" && message.id.startsWith("fenjue-review:") && !message.method) {
      const job = this.pending.get(message.id);
      if (this.starts.delete(message.id) && typeof message.result?.thread?.id === "string") this.threads.add(message.result.thread.id);
      if (job) {
        if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result);
      } else if (message.result?.thread?.id && this.threads.has(message.result.thread.id)) {
        this.send({ id: "fenjue-review:" + randomUUID(), method: "thread/archive", params: { threadId: message.result.thread.id } });
      }
      return true;
    }
    const p = message.params ?? {}, threadId = p.threadId ?? p.thread?.id;
    if (!this.threads.has(threadId)) return false;
    const work = this.running.get(threadId);
    if (message.id !== undefined && message.method) {
      const result = message.method.endsWith("requestApproval") ? { decision: "decline" } : undefined;
      this.send(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: "Expert review has no interactive input" } });
    }
    if (work) {
      if (message.method === "turn/started") work.turnId = p.turn?.id;
      if (message.method === "item/completed") work.items.push(p.item);
      if (message.method === "thread/tokenUsage/updated" && Number.isSafeInteger(p.tokenUsage?.total?.totalTokens)) {
        work.tokens = p.tokenUsage.total.totalTokens;
        if (work.tokens! >= work.config.maxTokens) work.controller.abort(new Error("专家 token 预算已耗尽"));
      }
      if (message.method === "item/started" && ["commandExecution", "mcpToolCall", "fileChange", "webSearch", "imageView"].includes(p.item?.type)) {
        if (++work.toolCalls >= work.config.maxToolCalls) work.controller.abort(new Error("专家工具预算已耗尽"));
      }
      if (message.method === "turn/completed") work.finish(p.turn);
    }
    return true;
  }

  private request(method: string, params: unknown, signal: AbortSignal): Promise<any> {
    const id = "fenjue-review:" + randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: any) => {
        this.pending.delete(id); signal.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(signal.reason);
      this.pending.set(id, { method, resolve: value => finish(undefined, value), reject: error => finish(error) });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      if (method === "thread/start") this.starts.add(id);
      this.send({ id, method, params });
    });
  }

  async review(cwd: string, prompt: string, config: NativeReviewConfig, cancellation: AbortSignal,
    observe: (details: Record<string, unknown>) => void): Promise<string> {
    const begin = Date.now(), controller = new AbortController();
    const signal = AbortSignal.any([cancellation, controller.signal, AbortSignal.timeout(config.timeoutMs)]);
    let threadId: string | undefined, work: RunningReview | undefined;
    const interrupt = () => {
      if (threadId && work?.turnId) this.send({ id: "fenjue-review:" + randomUUID(), method: "turn/interrupt", params: { threadId, turnId: work.turnId } });
    };
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      const effective = await this.request("config/read", { cwd, includeLayers: false }, signal);
      if (!record(effective?.config)) throw new Error("无法读取审查工作区配置，未启动专家");
      const servers = effective.config.mcp_servers;
      const disabledServers = Object.fromEntries(Object.entries(record(servers) ? servers : {}).map(([name, server]) => {
        if (!record(server)) throw new Error("无效 MCP 配置，未启动专家");
        // A disabled entry still needs a valid transport. Config/read returns
        // nullable optional fields that cannot be round-tripped through TOML.
        const transport = typeof server.command === "string" ? { command: server.command } :
          typeof server.url === "string" ? { url: server.url } : undefined;
        if (!transport) throw new Error("无法隔离 MCP 配置，未启动专家");
        return [name, { ...transport, enabled: false }];
      }));
      const started = await this.request("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
        model: config.model, developerInstructions: ARCHITECT_INSTRUCTIONS, config: { model_reasoning_effort: config.effort,
          mcp_servers: disabledServers, web_search: "disabled",
          "features.multi_agent": false, "features.memories": false, "features.hooks": false, "features.plugins": false,
          "features.apps": false, "features.remote_plugin": false, "features.shell_snapshot": false,
          "features.skip_host_skill_discovery": true } }, signal);
      threadId = started.thread.id;
      let resolveTurn!: (turn: any) => void, rejectTurn!: (error: Error) => void;
      const completed = new Promise<any>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      // turn/completed may arrive before the turn/start response is consumed.
      completed.catch(() => {});
      const cancelTurn = () => rejectTurn(signal.reason);
      signal.addEventListener("abort", cancelTurn, { once: true });
      work = { items: [], tokens: null, toolCalls: 0, finish: resolveTurn, controller, config };
      this.running.set(threadId!, work);
      try {
        signal.throwIfAborted();
        const turn = await this.request("turn/start", { threadId, input: [{ type: "text", text: prompt }], model: config.model, effort: config.effort,
          approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
          collaborationMode: { mode: "default", settings: { model: config.model, reasoning_effort: config.effort,
            developer_instructions: ARCHITECT_INSTRUCTIONS } } }, signal);
        work.turnId ??= turn.turn.id;
        signal.throwIfAborted();
        const done = await completed;
        const result = completedWork(threadId!, { ...done, items: [...work.items, ...(done.items ?? [])] });
        signal.throwIfAborted();
        if (result.status !== "completed" || !result.answer.trim()) throw new Error("专家审查未完成或缺少意见");
        observe({ reviewThreadId: threadId, reviewTurnId: result.turnId, status: "completed", advice: result.answer,
          elapsedMs: Date.now() - begin, tokens: work.tokens, toolCalls: work.toolCalls });
        return result.answer;
      } finally { signal.removeEventListener("abort", cancelTurn); }
    } catch (error) {
      observe({ reviewThreadId: threadId, reviewTurnId: work?.turnId, status: signal.aborted ? "cancelled" : "failed",
        error: String(error), elapsedMs: Date.now() - begin, tokens: work?.tokens ?? null, toolCalls: work?.toolCalls ?? 0 });
      throw error;
    } finally {
      signal.removeEventListener("abort", interrupt);
      if (threadId) {
        this.running.delete(threadId);
        this.send({ id: "fenjue-review:" + randomUUID(), method: "thread/archive", params: { threadId } });
      }
    }
  }
}
