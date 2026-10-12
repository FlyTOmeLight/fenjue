import { AUTO_MODEL, record, type Config } from "./config.js";
import { ClassificationError, classificationPayload, createClassifier, type Classification, type Classify } from "./classification.js";
import { policySelection, decisionConfidence, confidentNewTask, type Selection } from "./policy.js";
import { advanceTask, fingerprint, isContinuation, readTaskInput, taskView, type TaskState } from "./task-state.js";

export interface Decision extends Selection {
  reason: string;
  key: string;
  mode?: "shadow" | "auto";
  suggestedModel?: string;
  suggestedEffort?: string;
  classificationReason?: string;
  decisionConfidence?: number;
  classification?: Classification;
  boundaryClassification?: Classification;
}
interface State {
  signature: string; decision: Decision; generation: number;
  task: TaskState; history: string[]; lastPosition: number;
  suggestion?: Selection;
}
interface Pending { promise: Promise<State>; controller: AbortController; waiters: number; settled: boolean }
export interface Prepared { decision?: Decision; accept: () => void }

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort!); }
}

export class Router {
  private states = new Map<string, State>();
  private generations = new Map<string, number>();
  private plans = new Map<string, State>();
  private pending = new Map<string, Pending>();
  private classify?: Classify;
  constructor(private config: Config, classify?: Classify) {
    this.classify = classify ?? (config.semantic ? createClassifier(config.semantic) : undefined);
  }

  async prepare(body: Record<string, unknown>, signal?: AbortSignal): Promise<Prepared> {
    signal?.throwIfAborted();
    if (body.model !== AUTO_MODEL) return { accept() {} };
    const parsed = readTaskInput(body);
    const metadata = record(body.client_metadata) ? body.client_metadata : {};
    const identity = metadata.thread_id ?? body.prompt_cache_key;
    const key = fingerprint(identity ?? ["stateless", parsed.users.map(u => u.fingerprint)]);
    const previous = this.states.get(key);
    if (!parsed.users.length && !previous) throw new Error("无法恢复 auto 路线：请求缺少用户历史及已知会话。请恢复完整会话。");
    const signature = parsed.users.at(-1)?.fingerprint ?? previous!.signature;
    const planKey = key + ":" + signature;
    let state = this.plans.get(planKey);
    const reused = Boolean(state || this.pending.has(planKey) || previous?.signature === signature);
    if (!parsed.users.length || previous?.signature === signature) {
      state = previous!;
    }
    if (!state) {
      let pending = this.pending.get(planKey);
      if (!pending) {
        const generation = (this.generations.get(key) ?? 0) + 1;
        this.generations.set(key, generation);
        this.trim(this.generations);
        const controller = new AbortController();
        pending = { controller, waiters: 0, settled: false, promise: undefined! };
        const job = pending;
        job.promise = this.plan(parsed, previous, key, signature, generation, controller.signal).then(result => {
          controller.signal.throwIfAborted();
          this.plans.set(planKey, result); this.trim(this.plans);
          return result;
        }).finally(() => {
          job.settled = true;
          if (this.pending.get(planKey) === job) this.pending.delete(planKey);
        });
        this.pending.set(planKey, job);
      }
      pending.waiters++;
      try { state = await waitFor(pending.promise, signal); }
      finally {
        pending.waiters--;
        if (!pending.waiters && !pending.settled) {
          pending.controller.abort();
          if (this.pending.get(planKey) === pending) this.pending.delete(planKey);
        }
      }
    }
    signal?.throwIfAborted();
    // Both full-history and incremental tool continuations can precede a partial
    // user followup. Retain their evidence without creating another classification.
    const tail = parsed.evidence.filter(e => e.position > (parsed.users.at(-1)?.position ?? -1)).map(e => e.text);
    if (this.config.semantic && tail.length) state = {
      ...state, task: { ...state.task, evidence: [...new Set([...state.task.evidence, ...tail])] },
    };
    const decision = { ...state.decision, ...(reused ? { reason: "reused" } : {}) };
    body.model = decision.model;
    body.reasoning = { ...(record(body.reasoning) ? body.reasoning : {}), effort: decision.effort };
    const accepted = state;
    return { decision, accept: () => {
      if ((this.states.get(key)?.generation ?? 0) <= accepted.generation) {
        this.states.set(key, accepted); this.trim(this.states);
      }
    } };
  }

  private async plan(parsed: ReturnType<typeof readTaskInput>, previous: State | undefined, key: string,
    signature: string, generation: number, signal: AbortSignal): Promise<State> {
    const latest = parsed.users.at(-1)!;
    const explicitNew = /^\s*\[new\](?:\s|$)/.test(latest.text);
    const view = explicitNew ? {
      currentTask: { messages: [], evidence: [], incomplete: false }, newMessages: [latest.text], evidence: [], incomplete: latest.incomplete,
    } : taskView(parsed, previous);
    let route = previous?.decision.route ?? this.config.defaultRoute;
    let reason = "continuation";
    // Fixed mode remains deterministic, including history replay after restart.
    for (const user of parsed.users) {
      if (isContinuation(user.text)) continue;
      const rule = this.config.rules.find(r => user.text.trimStart().startsWith(r.prefix));
      route = rule?.route ?? this.config.defaultRoute;
      reason = rule ? "prefix-rule" : "default";
    }
    let decision: Decision = { ...this.config.routes[route]!, route, reason, key };
    let suggestion: Selection | undefined;
    let newTask = explicitNew;
    if (this.config.semantic) {
      const s = this.config.semantic;
      const baselineRoute = s.roles.balanced;
      const retained: Selection = previous?.decision ?? { ...this.config.routes[baselineRoute]!, route: baselineRoute };
      const priorSuggestion = previous?.suggestion ?? previous?.decision;
      const rule = this.config.rules.find(r => latest.text.trimStart().startsWith(r.prefix));
      let classification: Classification | undefined, boundaryClassification: Classification | undefined,
        classificationReason: string, score: number | undefined;
      if (rule) {
        suggestion = { ...this.config.routes[rule.route]!, route: rule.route };
        classificationReason = "prefix-rule";
      } else if (previous && view.newMessages.length === 1 && isContinuation(latest.text)) {
        suggestion = priorSuggestion;
        classificationReason = "continuation";
      } else {
        try {
          // The legacy Responses router retains its history contract. Native
          // routing can assess partial history with explicit coverage metadata.
          if (view.currentTask.incomplete) throw new ClassificationError("incomplete-context");
          classificationPayload(view, s);
          classification = await this.classify!(view, signal);
          signal.throwIfAborted();
          const confirmedNew = explicitNew || confidentNewTask(classification, s.minConfidence);
          if (confirmedNew && !explicitNew && (view.currentTask.messages.length > 0 || view.newMessages.length > 1)) {
            // Choice answers are independent. Once the boundary is known, old
            // failures must not participate in evaluating the new task's needs.
            boundaryClassification = classification;
            classification = undefined;
            const fresh = { currentTask: { messages: [], evidence: [], incomplete: false },
              newMessages: [latest.text], evidence: [], incomplete: latest.incomplete };
            classificationPayload(fresh, s);
            classification = await this.classify!(fresh, signal);
            signal.throwIfAborted();
          }
          score = decisionConfidence(classification);
          if (score < s.minConfidence) throw new ClassificationError("low-confidence");
          suggestion = policySelection(this.config, classification, priorSuggestion, confirmedNew);
          newTask ||= confirmedNew;
          classificationReason = "classified";
        } catch (error) {
          signal.throwIfAborted();
          suggestion = priorSuggestion ?? retained;
          classificationReason = error instanceof ClassificationError ? error.code : "unavailable";
        }
      }
      const actual = s.mode === "auto" ? suggestion! : decision;
      decision = { ...actual, key, reason: s.mode === "auto" ? classificationReason : reason, mode: s.mode,
        suggestedModel: suggestion!.model, suggestedEffort: suggestion!.effort, classificationReason, classification,
        boundaryClassification, decisionConfidence: score };
    }
    return { signature, decision, generation, task: this.config.semantic ? advanceTask(view, newTask) : { messages: [], evidence: [], incomplete: false },
      history: parsed.users.map(u => u.fingerprint), lastPosition: latest.position, suggestion };
  }

  close(): void { for (const job of this.pending.values()) job.controller.abort(); }
  private trim<T>(map: Map<string, T>): void {
    while (map.size > 512) map.delete(map.keys().next().value!);
  }
}
