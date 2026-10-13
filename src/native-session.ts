import { randomUUID } from "node:crypto";
import { AUTO_MODEL, record, type Config, type Route } from "./config.js";
import { ClassificationError, createClassifier, type Classify, type Classification, createDemandClassifier, classifierUsage, QUESTIONS, CONSTRAINT_QUESTION, DEMAND_POLICY, DEMAND_QUESTION, type ClassifyDemand, type ClassificationObservation } from "./classification.js";
import { confidentNewTask } from "./policy.js";
import { advanceTask, fingerprint, isContinuation, type TaskView, type TaskState } from "./task-state.js";
import { mainRoute, nativeSelection, nativePolicy, type NativeSelection } from "./native-policy.js";
import { emptyNativeState, isCapacityError, NativeRecords, type NativeEvent, type NativeMode, type NativeState } from "./native-records.js";
import { completedWork, RepeatedErrors, reviewPrompt } from "./architect-review.js";
import { NativeReviewer } from "./native-review.js";
import { classifierContext, CLASSIFIER_CONTEXT_POLICY } from "./classifier-context.js";

// The native protocol is an extensible envelope. Fields unrelated to routing
// are forwarded untouched, including server requests and their client replies.
export interface NativeMessage { id?: string | number; method?: string; params?: any; result?: any; error?: any }
interface Pending {
  message: NativeMessage; controller: AbortController; sent: boolean;
  state?: NativeState; decision?: Record<string, unknown>; text?: string; incomplete?: boolean;
  automatic?: boolean;
  decisionId?: string; receivedAt?: string;
  capacityRetry?: { previousError: any; parentTurnId: string };
}
interface ActiveTurn {
  turnId: string; route: Route;
  retry?: { parameters: any; blocked: boolean; previousError?: any };
}
function inputText(input: any): { text: string; incomplete: boolean } {
  const items = Array.isArray(input) ? input : [];
  return { text: items.filter(i => i?.type === "text" && typeof i.text === "string").map(i => i.text).join("\n"),
    incomplete: items.some(i => i?.type !== "text") };
}
function effective(params: any, fallback: Route): Route {
  const settings = params?.collaborationMode?.settings;
  return { model: settings?.model ?? params?.model ?? fallback.model,
    effort: settings?.reasoning_effort ?? params?.effort ?? fallback.effort };
}
function applyRoute(params: any, route: Route): void {
  Object.assign(params, route);
  if (record(params.collaborationMode) && record(params.collaborationMode.settings)) {
    Object.assign(params.collaborationMode.settings, { model: route.model, reasoning_effort: route.effort });
  }
}
function itemEvidence(item: any): string | undefined {
  if (item.type === "agentMessage" && typeof item.text === "string") return item.text;
  if (item.type === "commandExecution") return JSON.stringify({ command: item.command, exitCode: item.exitCode, output: item.aggregatedOutput });
  if (item.type === "mcpToolCall") return JSON.stringify({ server: item.server, tool: item.tool, status: item.status, result: item.result, error: item.error });
  if (item.type === "fileChange") return JSON.stringify({ type: item.type, status: item.status, changes: item.changes });
}

export class NativeSession {
  private states = new Map<string, NativeState>();
  private requests = new Map<string | number, NativeMessage>();
  private inspections = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private pending = new Map<string, Pending>();
  private active = new Map<string, ActiveTurn>();
  private seenItems = new Set<string>();
  private initialInputs = new Map<string, string>();
  private resumedContexts = new Map<string, TaskState>();
  private resumeHeads = new Map<string, { id: string; status: string }>();
  private historyNeeded = new Set<string>();
  private foreground?: string;
  private directories = new Map<string, string>();
  private reviewJobs = new Map<string, AbortController>();
  private errors = new Map<string, { taskId: string; tracker: RepeatedErrors }>();
  private workItems = new Map<string, any[]>();
  private turnParameters = new Map<string, any>();
  private reviewer: NativeReviewer;
  private closed = false;
  private classify: Classify;
  private policy: string;
  private classifyDemand: ClassifyDemand;
  private demandJobs = new Set<AbortController>();
  constructor(private config: Config, private records: NativeRecords,
    private sendServer: (message: NativeMessage) => void, private sendClient: (message: NativeMessage) => void,
    private onEvent: (event: NativeEvent) => void = () => {}, classify?: Classify, private initialManual = false, classifyDemand?: ClassifyDemand) {
    this.classify = classify ?? createClassifier(config.semantic!, undefined, undefined, config.native?.expertPolicy === "constraints");
    this.classifyDemand = classifyDemand ?? createDemandClassifier(config.semantic!);
    this.reviewer = new NativeReviewer(sendServer);
    this.policy = nativePolicy(config) + ":" + fingerprint({ routes: config.routes, native: config.native, semantic: config.semantic,
      classifierContext: CLASSIFIER_CONTEXT_POLICY });
  }
  private emit(type: string, threadId?: string, details: Record<string, unknown> = {}): void {
    const state = threadId ? this.states.get(threadId) : undefined;
    const active = threadId ? this.active.get(threadId) : undefined;
    const route = active && active.turnId === details.turnId ? active.route : state?.route;
    const event = { type, threadId, taskId: state?.taskId, mode: state?.mode, route, ...details };
    this.records.event(event); this.onEvent(event);
  }
  private replyError(message: NativeMessage, reason: string): void {
    if (message.id !== undefined) this.sendClient({ id: message.id, error: { code: -32000, message: reason } });
  }
  private cancel(threadId: string, reason: string): boolean {
    const pending = this.pending.get(threadId);
    if (!pending || pending.sent) return false;
    pending.controller.abort(); this.pending.delete(threadId);
    if (pending.state) this.records.discardExecution(threadId, pending.state.taskId);
    this.replyError(pending.message, reason); this.emit("classification-cancelled", threadId, { reason });
    return true;
  }
  setMode(mode: NativeMode): void {
    if (!this.foreground) throw new Error("当前没有已绑定的前台会话");
    const threadId = this.foreground, state = this.states.get(threadId)!;
    if (mode !== "auto") this.reviewJobs.get(threadId)?.abort(new Error("已停止自动审查"));
    this.cancel(threadId, "路由模式已改变，请重新提交本轮");
    const fromMode = state.mode;
    state.mode = mode;
    const submitted = this.pending.get(threadId)?.state;
    if (submitted) submitted.mode = mode;
    if (mode === "auto") state.suggestion = undefined;
    this.records.save(threadId, state); this.emit("mode", threadId, { reason: "user-control", fromMode, toMode: mode, fromRoute: { ...state.route }, toRoute: { ...state.route }, turnId: state.activeTurnId ?? state.lastTurnId });
  }
  async fromClient(message: NativeMessage): Promise<void> {
    if (this.closed) return;
    const p = message.params ?? {}, threadId = p.threadId as string | undefined;
    if (!p.ephemeral && (message.method === "thread/resume" || message.method === "thread/fork" ||
      (message.method === "thread/start" && p.threadSource === "user"))) {
      for (const job of this.reviewJobs.values()) job.abort(new Error("用户切换了会话"));
      for (const active of this.active.values()) if (active.retry) active.retry.blocked = true;
    }
    if (message.method === "thread/list") {
      const provider = this.config.auth === "mock" ? "fenjue_native_fixture" : "openai";
      // The native picker filters by provider. Include earlier Fenjue sessions
      // so resume --last does not silently select an older unrelated thread.
      if (p.modelProviders == null) p.modelProviders = [provider, "fenjue"];
      else if (Array.isArray(p.modelProviders) && p.modelProviders.includes(provider) && !p.modelProviders.includes("fenjue")) {
        p.modelProviders = [...p.modelProviders, "fenjue"];
      }
    }
    if (message.method === "thread/resume" && threadId) {
      const restored = this.records.load(threadId);
      if (restored && !this.initialManual) {
        if (p.excludeTurns && !p.initialTurnsPage) {
          try {
            const head = (await this.inspect(threadId, "thread/turns/list")).data?.[0];
            if (head) this.resumeHeads.set(threadId, head);
          } catch { /* A missing snapshot remains explicitly unknown below. */ }
          if (this.closed) return;
        }
        // Native resume can restore the model but reapply its default effort.
        // Restore the accepted pair through native config before the TUI sees it.
        p.model = restored.route.model;
        p.config = { ...(record(p.config) ? p.config : {}), model_reasoning_effort: restored.route.effort };
      } else if (!restored) {
        let thread: any;
        try { thread = (await this.inspect(threadId)).thread; }
        catch { this.replyError(message, "无法读取待恢复会话的模型设置，请重试恢复"); return; }
        if (this.closed) return;
        if (thread?.model === AUTO_MODEL && thread.modelProvider === "fenjue") {
          // Existing daily sessions were persisted under the virtual provider.
          // Enter the native engine with a concrete model and a conservative
          // high floor; missing legacy task context is explicitly marked below.
          p.model = this.initialManual && p.model && p.model !== AUTO_MODEL ? p.model : mainRoute(this.config).model;
          p.modelProvider = this.config.auth === "mock" ? "fenjue_native_fixture" : "openai";
          if (!this.initialManual) p.config = { ...(record(p.config) ? p.config : {}), model_reasoning_effort: "high" };
          this.emit("legacy-resume", threadId, { reason: "legacy-context-unknown" });
        } else if (thread?.reasoningEffort && !this.initialManual) {
          p.config = { ...(record(p.config) ? p.config : {}), model_reasoning_effort: thread.reasoningEffort };
        }
      }
    }
    const state = threadId ? this.states.get(threadId) : undefined;
    if (threadId && ["turn/start", "turn/interrupt", "thread/settings/update", "thread/rollback", "thread/archive"].includes(message.method ?? "")) {
      const retry = this.active.get(threadId)?.retry;
      if (retry) retry.blocked = true;
      const review = this.reviewJobs.get(threadId);
      if (review) {
        review.abort(new Error("用户操作取消了旧审查"));
        if (message.method === "turn/interrupt" && !this.active.has(threadId)) {
          this.sendClient({ id: message.id, result: {} }); return;
        }
      }
    }
    if (message.method === "turn/interrupt" && threadId && this.cancel(threadId, "已取消路由评估，本轮尚未执行")) {
      this.sendClient({ id: message.id, result: {} }); return;
    }
    if (message.method === "thread/settings/update" && state && threadId && (p.model != null || p.effort != null)) {
      this.cancel(threadId, "已手动选择模型，本轮尚未执行，请重新提交");
    }
    if (message.method === "turn/start" && state && threadId && !p.toolOutput) {
      this.foreground = threadId;
      const active = this.active.get(threadId);
      if (active) {
        // Native turn/start can be a steer. Pin the active lease even when the
        // UI has already selected a different model for its next turn.
        applyRoute(p, active.route);
      } else {
        if (this.pending.has(threadId) || [...this.requests.values()].some(r => r.method === "thread/settings/update" && r.params.threadId === threadId)) {
          this.replyError(message, "该会话仍在提交轮次或修改设置，请等待完成"); return;
        }
        const input = inputText(p.input);
        if (input.text || input.incomplete) {
          const job: Pending = { message, controller: new AbortController(), sent: false, ...input, decisionId: randomUUID(), receivedAt: new Date().toISOString() };
          this.pending.set(threadId, job); this.emit(state.mode === "manual" ? "submitting" : "classifying", threadId, { decisionId: job.decisionId, receivedAt: job.receivedAt });
          try {
            if (state.mode !== "manual" && !/^\s*\[new\](?:\s|$)/.test(input.text) && this.historyNeeded.has(threadId)) {
              await this.recoverHistory(threadId, job.controller.signal);
            }
            const result = await this.plan(state, input, p, job.controller.signal, job.decisionId!);
            job.state = result.state;
            if (!result.state.task.incomplete && (state.task.messages.length === 0 || state.taskId !== result.state.taskId)) {
              await this.records.prepareExecution(threadId, result.state, p.cwd ?? this.directories.get(threadId), input.text, job.controller.signal);
            }
            job.controller.signal.throwIfAborted();
            Object.assign(job, result);
            if (state.mode === "auto") applyRoute(p, result.state.route);
            job.sent = true;
            this.emit("planned", threadId, { ...result.decision, route: result.state.route });
          } catch (error) {
            if (!job.controller.signal.aborted) {
              this.pending.delete(threadId); this.replyError(message, String(error));
            }
            return;
          }
        }
      }
    }
    if (message.id !== undefined && message.method) this.requests.set(message.id, message);
    this.sendServer(message);
  }
  fromServer(message: NativeMessage): void {
    if (this.reviewer.fromServer(message)) return;
    if (typeof message.id === "string" && message.id.startsWith("fenjue:") && !message.method) {
      const request = this.requests.get(message.id);
      if (request) { this.requests.delete(message.id); this.response(request, message); }
      const inspection = this.inspections.get(message.id);
      if (inspection) {
        this.inspections.delete(message.id); clearTimeout(inspection.timer);
        if (message.error) inspection.reject(new Error(message.error.message)); else inspection.resolve(message.result);
        return;
      }
      // A cancelled or timed-out inspection still belongs to the gateway.
      return;
    }
    const p = message.params ?? {}, threadId = p.threadId as string | undefined;
    if (message.id !== undefined && !message.method) {
      const request = this.requests.get(message.id);
      this.requests.delete(message.id);
      if (request) this.response(request, message);
    }
    const state = threadId ? this.states.get(threadId) : undefined;
    const active = threadId ? this.active.get(threadId) : undefined;
    if (active?.retry && (!p.turnId || p.turnId === active.turnId) && message.method?.startsWith("item/") && p.item?.type !== "userMessage") {
      // Starts, deltas and approval requests arrive before completed items.
      // Once any output/work begins, replaying the input is no longer safe.
      active.retry.blocked = true;
    }
    if (threadId && state) {
      if (message.method === "turn/started" && typeof p.turn?.id === "string") {
        this.accept(threadId, p.turn.id);
        if (this.active.get(threadId)?.turnId !== p.turn.id) {
          this.active.set(threadId, { turnId: p.turn.id, route: { ...this.states.get(threadId)!.route } });
        }
      } else if (message.method === "thread/settings/updated") {
        const settings = p.threadSettings;
        if (typeof settings?.model === "string") {
          state.route = { model: settings.model, effort: settings.reasoningEffort ?? settings.effort ?? state.route.effort };
          this.records.save(threadId, state);
        }
      } else if (message.method === "item/completed") {
        this.item(threadId, p.turnId, p.item);
        if (this.config.native?.review && p.item?.type !== "reasoning") {
          const key = threadId + ":" + p.turnId;
          const items = this.workItems.get(key) ?? []; items.push(p.item); this.workItems.set(key, items);
        }
      }
      else if (message.method === "turn/completed") {
        const turn = p.turn;
        if (turn?.id) {
          // Some transports only include the final item in the completed turn.
          for (const item of turn.items ?? []) this.item(threadId, turn.id, item);
          state.lastTurnId = turn.id; delete state.activeTurnId;
          const route = this.active.get(threadId)?.route ?? state.route;
          if (this.active.get(threadId)?.turnId === turn.id) this.active.delete(threadId);
          this.records.save(threadId, state);
          this.emit("completed", threadId, { turnId: turn.id, route, status: turn.status, quality: "unknown",
            error: turn.error ? { message: turn.error.message, codexErrorInfo: turn.error.codexErrorInfo } : undefined,
            ...(active && active.turnId === turn.id && active.retry?.previousError ? { previousError: active.retry.previousError } : {}) });
        }
      } else if (message.method === "model/rerouted") {
        this.emit("rerouted", threadId, { turnId: p.turnId, fromModel: p.fromModel, toModel: p.toModel, reason: p.reason });
      } else if (message.method === "thread/tokenUsage/updated") {
        this.emit("usage", threadId, { turnId: p.turnId, tokenUsage: p.tokenUsage });
      }
    }
    this.sendClient(message);
    if (threadId && state && message.method === "turn/completed") {
      const key = threadId + ":" + p.turn.id;
      if (active && active.turnId === p.turn.id && this.retryCapacity(threadId, p.turn, active)) {
        this.workItems.delete(key); return;
      }
      const work = completedWork(threadId, { ...p.turn, items: [...(this.workItems.get(key) ?? []), ...(p.turn.items ?? [])] });
      this.workItems.delete(key);
      void this.automaticReview(threadId, work);
    }
  }
  private response(request: NativeMessage, response: NativeMessage): void {
    const p = request.params ?? {}, threadId = p.threadId as string | undefined;
    if (["thread/start", "thread/resume", "thread/fork"].includes(request.method!)) {
      if (response.error || p.ephemeral || (p.threadSource && p.threadSource !== "user") ||
          (request.method === "thread/start" && p.threadSource !== "user")) return;
      const r = response.result, id = r?.thread?.id;
      if (r?.thread?.ephemeral || r?.thread?.parentThreadId || (r?.thread?.threadSource && r.thread.threadSource !== "user")) return;
      if (typeof id !== "string") return;
      const baseline = { model: r.model ?? mainRoute(this.config).model, effort: r.reasoningEffort ?? mainRoute(this.config).effort };
      const restored = request.method === "thread/resume" ? this.records.load(id) : undefined;
      const state = restored ?? emptyNativeState(this.initialManual ? "manual" : this.config.semantic!.mode, baseline, this.policy);
      if (this.initialManual) state.mode = "manual";
      let history: Record<string, unknown> | undefined;
      if (request.method !== "thread/start") {
        const turns = r.thread.turns ?? [];
        const page = r.initialTurnsPage?.data ?? [];
        const last = turns.length ? turns.at(-1) : page.length ? (p.initialTurnsPage?.sortDirection === "asc" ? page.at(-1) : page[0]) : this.resumeHeads.get(id);
        this.resumeHeads.delete(id);
        history = { recordedTurn: restored?.lastTurnId, nativeTurn: last?.id, unfinished: Boolean(restored?.activeTurnId),
          samePolicy: restored?.policy === this.policy, turns: turns.length, page: page.length };
        // A saved cursor must match the native snapshot. Missing/paginated or
        // externally advanced history cannot silently become a simpler task.
        if (!restored || restored.activeTurnId || last?.id !== restored.lastTurnId) {
          state.task.incomplete = true;
        }
        if (state.task.incomplete) this.historyNeeded.add(id);
        if (!restored || this.initialManual) state.route = baseline;
        if (last?.status === "inProgress") this.active.set(id, { turnId: last.id, route: baseline });
        delete state.activeTurnId;
      }
      state.policy = this.policy;
      this.states.set(id, state); this.foreground = id;
      if (typeof (r.cwd ?? p.cwd) === "string") this.directories.set(id, r.cwd ?? p.cwd);
      if (request.method !== "thread/start") this.resumedContexts.set(id, structuredClone(state.task));
      this.records.save(id, state); this.emit("bound", id, { reason: state.task.incomplete ? "history-unknown" : "ready", history });
    } else if (request.method === "turn/start" && threadId) {
      const pending = this.pending.get(threadId);
      if (pending && pending.message.id === request.id) {
        if (!response.error && response.result?.turn?.id) this.accept(threadId, response.result.turn.id);
        else if (response.error) {
          if (pending.state) this.records.discardExecution(threadId, pending.state.taskId);
          if (pending.capacityRetry) this.emit("retry-failed", threadId, { status: "failed", turnId: pending.capacityRetry.parentTurnId, route: pending.state?.route,
            error: { message: response.error.message, codexErrorInfo: response.error.data?.codexErrorInfo },
            previousError: pending.capacityRetry.previousError });
          else this.emit("rejected", threadId, { reason: response.error.message });
        }
        this.pending.delete(threadId);
      }
    } else if (request.method === "thread/settings/update" && threadId && !response.error) {
      const state = this.states.get(threadId);
      if (state && (p.model != null || p.effort != null)) {
        const fromRoute = { ...state.route }, fromMode = state.mode;
        state.mode = "manual"; state.route = effective(p, state.route);
        this.records.save(threadId, state); this.emit("mode", threadId, { reason: "native-model-picker", fromRoute, toRoute: { ...state.route }, fromMode, toMode: state.mode, turnId: state.activeTurnId ?? state.lastTurnId });
      }
    } else if (request.method === "thread/rollback" && threadId && !response.error) {
      const state = this.states.get(threadId);
      if (state) { state.task.incomplete = true; this.historyNeeded.add(threadId); this.records.save(threadId, state); }
    }
  }
  private accept(threadId: string, turnId: string): void {
    const job = this.pending.get(threadId);
    if (!job?.sent || !job.state) return;
    this.pending.delete(threadId);
    const state = job.state;
    if (this.states.get(threadId)?.taskId !== state.taskId) this.historyNeeded.delete(threadId);
    state.activeTurnId = turnId;
    this.states.set(threadId, state);
    this.active.set(threadId, { turnId, route: { ...state.route },
      ...(!job.automatic && state.mode === "auto" ? { retry: { parameters: structuredClone(job.message.params), blocked: false,
        ...(job.capacityRetry ? { previousError: job.capacityRetry.previousError } : {}) } } : {}) });
    this.records.save(threadId, state);
    if (job.capacityRetry) this.records.retryExecution(threadId, state.taskId, job.capacityRetry.parentTurnId, turnId);
    if (job.automatic) {
      state.review!.revisionTurns.push(turnId);
      this.records.capture(threadId, state, turnId, [{ kind: "evidence", text: job.text! }]);
    } else if (!job.capacityRetry) this.records.capture(threadId, state, turnId, [{ kind: "user", text: job.text!, incomplete: job.incomplete }], this.resumedContexts.get(threadId));
    this.turnParameters.set(threadId, structuredClone(job.message.params));
    this.records.save(threadId, state);
    this.resumedContexts.delete(threadId);
    this.initialInputs.set(threadId + ":" + turnId, job.text!);
    this.emit("accepted", threadId, { turnId, receivedAt: job.receivedAt, ...job.decision });
  }
  private retryCapacity(threadId: string, turn: any, active: ActiveTurn): boolean {
    const attempt = active.retry, state = this.states.get(threadId);
    if (!attempt || attempt.blocked || attempt.previousError || !state || this.closed || state.mode !== "auto" ||
        this.foreground !== threadId || turn.status !== "failed" || !isCapacityError(turn.error) ||
        (turn.items ?? []).some((item: any) => item.type !== "userMessage") || this.active.has(threadId) || this.pending.has(threadId)) return false;
    const main = mainRoute(this.config).model, expert = this.config.native?.expertModel;
    if (!expert || expert === main || ![main, expert].includes(active.route.model) || !["low", "medium", "high"].includes(active.route.effort)) return false;
    const route = { model: active.route.model === main ? expert : main,
      effort: active.route.effort === "low" ? "medium" : active.route.effort };
    const params = structuredClone(attempt.parameters); applyRoute(params, route);
    const message: NativeMessage = { id: "fenjue:" + randomUUID(), method: "turn/start", params };
    const retryState = structuredClone(state); retryState.route = route;
    const input = inputText(params.input);
    this.pending.set(threadId, { message, controller: new AbortController(), sent: true, state: retryState, ...input,
      capacityRetry: { previousError: turn.error, parentTurnId: turn.id },
      decision: { reason: "capacity-retry", parentTurnId: turn.id, attempt: 1, policy: this.policy } });
    this.requests.set(message.id!, message);
    this.records.retryExecution(threadId, state.taskId, turn.id);
    this.emit("retrying", threadId, { turnId: turn.id, route, fromModel: active.route.model, toModel: route.model, attempt: 1 });
    this.sendServer(message);
    return true;
  }
  private inspect(threadId: string, method = "thread/read", params?: Record<string, unknown>, signal?: AbortSignal,
    beforeSend?: (message: NativeMessage) => void): Promise<any> {
    const id = "fenjue:" + randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: any) => {
        clearTimeout(timer); this.inspections.delete(id); signal?.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(signal!.reason);
      const timer = setTimeout(() => finish(new Error("Native thread inspection timed out")), 10_000);
      this.inspections.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error), timer });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      const message = { id, method, params: params ?? (method === "thread/read" ? { threadId, includeTurns: false } :
        { threadId, limit: 1, sortDirection: "desc", itemsView: "summary" }) };
      beforeSend?.(message); this.sendServer(message);
    });
  }
  private async recoverHistory(threadId: string, signal: AbortSignal): Promise<void> {
    this.historyNeeded.delete(threadId);
    const state = this.states.get(threadId)!;
    const turns: any[] = [];
    let cursor: string | undefined, complete = false, bytes = 0;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      do {
        const page = await this.inspect(threadId, "thread/turns/list", {
          threadId, cursor, limit: 10, sortDirection: "desc", itemsView: "full",
        }, deadline);
        if (!Array.isArray(page.data)) break;
        turns.push(...page.data); bytes += Buffer.byteLength(JSON.stringify(page.data));
        cursor = page.nextCursor ?? undefined;
        if (!cursor) { complete = true; break; }
      } while (bytes < this.config.semantic!.maxInputBytes);
    } catch {
      if (signal.aborted) this.historyNeeded.add(threadId);
      signal.throwIfAborted();
    }
    if (!turns.length) return;
    const task: TaskState = { messages: [], evidence: [], incomplete: !complete };
    for (const turn of [...turns].reverse()) {
      if (turn.itemsView !== "full" || !Array.isArray(turn.items)) task.incomplete = true;
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage" && !state.review?.revisionTurns.includes(turn.id)) {
          const input = inputText(item.content);
          if (input.text) task.messages.push(input.text);
          task.incomplete ||= input.incomplete;
        } else {
          const text = itemEvidence(item); if (text) task.evidence.push(text);
          if (item.type === "contextCompaction") task.incomplete = true;
        }
      }
    }
    if (task.incomplete) {
      // Keep known constraints when the native page window is incomplete.
      task.messages = [...new Set([...state.task.messages, ...task.messages])];
      task.evidence = [...new Set([...state.task.evidence, ...task.evidence])];
    }
    state.task = task; state.lastTurnId = turns[0].id;
    this.resumedContexts.set(threadId, structuredClone(task));
    this.records.save(threadId, state);
    this.emit("history-restored", threadId, { complete: !task.incomplete, turns: turns.length });
  }
  private async automaticReview(threadId: string, work: ReturnType<typeof completedWork>): Promise<void> {
    const config = this.config.native?.review, state = this.states.get(threadId), cwd = this.directories.get(threadId);
    if (!config || !state || this.closed) return;
    let errors = this.errors.get(threadId);
    if (errors?.taskId !== state.taskId) {
      errors = { taskId: state.taskId, tracker: new RepeatedErrors() }; this.errors.set(threadId, errors);
    }
    const evidence = errors!.tracker.observe(work.items);
    const parameters = this.turnParameters.get(threadId);
    if (!evidence || work.status !== "completed" || state.mode !== "auto" || !cwd || !parameters ||
        parameters.collaborationMode?.mode === "plan" || this.active.has(threadId) || this.pending.has(threadId) || this.reviewJobs.has(threadId)) return;
    if ((state.review?.count ?? 0) >= config.maxReviewsPerTask) return;
    const prompt = reviewPrompt("repeated-error", state.task.messages, work, evidence);
    if (state.task.incomplete || Buffer.byteLength(prompt) > 48 * 1024) {
      this.emit("review-skipped", threadId, { turnId: work.turnId, reason: "review-context-incomplete-or-too-large" }); return;
    }
    const controller = new AbortController(); this.reviewJobs.set(threadId, controller);
    state.review ??= { count: 0, revisionTurns: [] }; state.review.count++;
    this.records.save(threadId, state);
    this.records.markReview(threadId, state.taskId);
    this.emit("review-started", threadId, { turnId: work.turnId, reviewRoute: { model: config.model, effort: config.effort }, checkpoint: "repeated-error", evidence });
    try {
      const advice = await this.reviewer.review(cwd, prompt, config, controller.signal, details => {
        this.emit("review-finished", threadId, { taskId: state.taskId, turnId: work.turnId,
          reviewRoute: { model: config.model, effort: config.effort }, ...details });
      });
      controller.signal.throwIfAborted();
      if (this.closed || this.states.get(threadId) !== state || state.mode !== "auto" || this.active.has(threadId) || this.pending.has(threadId)) return;
      const text = "Fenjue 自动专家审查：观察到代码改动后同一测试再次失败。下面是只读专家的意见。请先核对当前代码和证据；有依据的问题再修正并自测。已经解决或不适用的意见说明理由，不扩大原任务范围。最后报告结果。\n" + advice;
      state.task.evidence.push("只读专家审查意见：\n" + advice);
      const params = structuredClone(parameters); params.input = [{ type: "text", text }]; applyRoute(params, state.route);
      this.emit("review-revision", threadId, { turnId: work.turnId, reason: "architect-revision" });
      this.reviewJobs.delete(threadId);
      await this.inspect(threadId, "turn/start", params, undefined, message => {
        this.pending.set(threadId, { message, controller, sent: true, state, text, automatic: true,
          decision: { reason: "architect-revision", policy: this.policy, origin: "architect-revision", parentTurnId: work.turnId } });
        this.requests.set(message.id!, message);
      });
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) this.emit("review-error", threadId, { taskId: state.taskId, turnId: work.turnId, reason: String(error) });
    } finally {
      if (this.reviewJobs.get(threadId) === controller) this.reviewJobs.delete(threadId);
    }
  }
  private item(threadId: string, turnId: string, item: any): void {
    if (!item?.id || !turnId) return;
    const key = threadId + ":" + turnId + ":" + item.id;
    if (this.seenItems.has(key)) return;
    this.seenItems.add(key);
    const state = this.states.get(threadId)!;
    if (item.type === "userMessage") {
      const input = inputText(item.content), initialKey = threadId + ":" + turnId;
      const initial = this.initialInputs.get(initialKey); this.initialInputs.delete(initialKey);
      if (initial !== input.text && (input.text || input.incomplete)) {
        state.task.messages.push(input.text); state.task.incomplete ||= input.incomplete;
        this.records.capture(threadId, state, turnId, [{ kind: "user", ...input }]);
        this.records.save(threadId, state);
      }
      return;
    }
    const text = itemEvidence(item);
    // Deliberately exclude reasoning items. A completed turn is observable;
    // private reasoning is neither needed nor collected for evaluation.
    if (text) {
      state.task.evidence.push(text); state.lastItemId = item.id;
      this.records.save(threadId, state);
      this.records.capture(threadId, state, turnId, [{ kind: "evidence", text }]);
      this.emit(item.type === "agentMessage" && item.phase === "final_answer" ? "final-answer" : "evidence", threadId,
        { turnId, itemId: item.id, itemType: item.type, phase: item.phase, exitCode: item.exitCode });
    }
  }
  private async plan(previous: NativeState, input: { text: string; incomplete: boolean }, params: any, signal: AbortSignal, decisionId: string): Promise<{ state: NativeState; decision: Record<string, unknown> }> {
    const state = structuredClone(previous), explicitNew = /^\s*\[new\](?:\s|$)/.test(input.text);
    const view: TaskView = { currentTask: explicitNew ? { messages: [], evidence: [], incomplete: false } : previous.task,
      newMessages: [input.text], evidence: [], incomplete: input.incomplete };
    let newTask = explicitNew, reason = "manual", classification: Classification | undefined, boundaryClassification: Classification | undefined;
    let selection: NativeSelection | undefined;
    let suggestion = explicitNew ? mainRoute(this.config) : previous.suggestion ?? previous.route;
    const classifierCalls: Record<string, unknown>[] = [];
    let demandView: TaskView | undefined;
    const classify = async (context: TaskView, phase: "initial" | "new-task") => {
      const call = await this.measuredClassification(params.threadId, previous.taskId, decisionId, phase, context,
        signal, observe => this.classify(context, signal, observe));
      classifierCalls.push(call.measurement);
      if (call.error) throw call.error;
      return call.result!;
    };
    const prepare = (inputView: TaskView, phase: "initial" | "new-task") => {
      const started = performance.now();
      try { return this.classifierView(inputView); }
      catch (error) {
        const questions = this.config.native?.expertPolicy === "constraints" ? { ...QUESTIONS, constraints: CONSTRAINT_QUESTION } : QUESTIONS;
        const measurement = { callId: randomUUID(), decisionId, phase, elapsedMs: Math.round(performance.now() - started),
          httpAttempted: false, usage: classifierUsage(null), inputPrepared: false, inputDigest: fingerprint(inputView),
          questionnaireDigest: fingerprint(questions), contextPolicy: CLASSIFIER_CONTEXT_POLICY,
          error: error instanceof ClassificationError ? error.code : "unavailable" };
        classifierCalls.push(measurement);
        this.emit("classification-call", params.threadId, { taskId: previous.taskId, ...measurement, input: inputView });
        throw error;
      }
    };
    const current = effective(params, previous.route);
    if (previous.mode !== "manual") {
      const s = this.config.semantic!, text = input.text.trimStart();
      const nativeRule = this.config.native?.rules?.find(r => text.startsWith(r.prefix));
      const rule = this.config.rules.find(r => text.startsWith(r.prefix));
      if (nativeRule || rule) {
        suggestion = nativeRule ? { model: nativeRule.model, effort: nativeRule.effort } : this.config.routes[rule!.route]!;
        reason = "prefix-rule";
      } else if (!explicitNew && previous.task.messages.length && isContinuation(input.text)) reason = "continuation";
      else {
        try {
          const context = prepare(view, "initial");
          classification = await classify(context, "initial");
          demandView = context; signal.throwIfAborted();
          newTask ||= confidentNewTask(classification, s.minConfidence);
          if (newTask && !explicitNew && previous.task.messages.length) {
            boundaryClassification = classification;
            demandView = prepare({ ...view, currentTask: { messages: [], evidence: [], incomplete: false } }, "new-task");
            classification = await classify(demandView, "new-task");
            signal.throwIfAborted();
          }
          selection = nativeSelection(this.config, classification, newTask ? undefined : previous.suggestion ?? previous.route);
          suggestion = selection.route;
          reason = selection.reason;
        } catch (error) {
          signal.throwIfAborted(); reason = error instanceof ClassificationError ? error.code : "unavailable";
          newTask = explicitNew;
        }
      }
    }
    state.route = previous.mode === "auto" ? suggestion : current;
    if (newTask) delete state.review;
    state.policy = this.policy; state.suggestion = suggestion; state.task = advanceTask(view, newTask);
    if (newTask) state.taskId = randomUUID();
    if (classification && selection && demandView && this.config.native?.reasoningDemand === "shadow") {
      this.startDemandShadow(params.threadId, state.taskId, decisionId, structuredClone(demandView), signal);
    }
    return { state, decision: { decisionId, classifierCalls, reason, suggestion, classification, boundaryClassification, policy: this.policy,
      ...(selection ? { routeSupport: selection.support, held: selection.held } : {}) } };
  }
  private async measuredClassification<T>(threadId: string, taskId: string, decisionId: string, phase: string,
    view: TaskView, signal: AbortSignal, run: (observe: (o: ClassificationObservation) => void) => Promise<T>, inputPrepared = true) {
    const started = performance.now(), callId = randomUUID();
    this.emit("classification-started", threadId, { taskId, callId, decisionId, phase });
    let observation: { httpAttempted: boolean | null; usage: ReturnType<typeof classifierUsage> } = { httpAttempted: null, usage: classifierUsage(null) };
    let result: T | undefined, error: Error | undefined;
    try { result = await run(o => { observation = o; }); signal.throwIfAborted(); }
    catch (e) { error = e instanceof Error ? e : new Error(String(e)); }
    const questions = phase === "demand-shadow" ? { demand: DEMAND_QUESTION } :
      this.config.native?.expertPolicy === "constraints" ? { ...QUESTIONS, constraints: CONSTRAINT_QUESTION } : QUESTIONS;
    const measurement = { callId, decisionId, phase, elapsedMs: Math.round(performance.now() - started),
      ...observation, inputPrepared, inputDigest: fingerprint(view), questionnaireDigest: fingerprint(questions), contextPolicy: CLASSIFIER_CONTEXT_POLICY,
      ...(error ? { error: error instanceof ClassificationError ? error.code : signal.aborted ? "cancelled" : "unavailable" } : {}) };
    this.emit("classification-call", threadId, { taskId, ...measurement, input: view,
      ...(phase === "demand-shadow" ? { demandPolicy: DEMAND_POLICY } : {}) });
    return { result, error, measurement };
  }
  private startDemandShadow(threadId: string, taskId: string, decisionId: string, view: TaskView, parent: AbortSignal): void {
    const controller = new AbortController(); this.demandJobs.add(controller);
    const signal = AbortSignal.any([parent, controller.signal]);
    void this.measuredClassification(threadId, taskId, decisionId, "demand-shadow", view, signal,
      observe => this.classifyDemand(view, signal, observe)).then(call => {
        if (!call.error && !this.closed) this.emit("demand-shadow", threadId, { taskId, decisionId,
          callId: call.measurement.callId, demandPolicy: DEMAND_POLICY, ...call.result });
      }).finally(() => this.demandJobs.delete(controller));
  }
  private classifierView(view: TaskView): TaskView {
    return classifierContext(view, this.config.semantic!, this.config.native?.expertPolicy === "constraints");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.demandJobs) job.abort(new Error("Native connection closed"));
    this.demandJobs.clear();
    for (const job of this.reviewJobs.values()) job.abort(new Error("Native connection closed"));
    this.reviewJobs.clear(); this.workItems.clear();
    for (const [threadId, job] of this.pending) {
      job.controller.abort();
      if (job.state) this.records.discardExecution(threadId, job.state.taskId);
      this.emit("disconnected", threadId, { submitted: job.sent, quality: "unknown" });
    }
    for (const [threadId, active] of this.active) this.emit("disconnected", threadId, { turnId: active.turnId, quality: "unknown" });
    this.pending.clear(); this.requests.clear();
    for (const job of this.inspections.values()) { clearTimeout(job.timer); job.reject(new Error("Native connection closed")); }
    this.inspections.clear();
  }
}
