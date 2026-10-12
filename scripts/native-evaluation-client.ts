import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type { NativeMessage } from "../src/native-session.js";

export class EvaluationClient {
  private ws: WebSocket;
  private events = new EventEmitter();
  private sequence = 0;
  private failure?: Error;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly messages: NativeMessage[] = [];
  constructor(socket: string, private notify: (message: NativeMessage) => void) {
    this.ws = new WebSocket(`ws+unix://${socket}:/`);
    this.ws.on("error", error => this.fail(error));
    this.ws.on("close", () => this.fail(new Error("Native evaluation connection closed")));
    this.ws.on("message", data => {
      const message: NativeMessage = JSON.parse(data.toString());
      this.messages.push(message);
      if (message.id !== undefined && !message.method) {
        const job = this.pending.get(Number(message.id));
        if (job) {
          clearTimeout(job.timer); this.pending.delete(Number(message.id));
          if (message.error) job.reject(new Error(JSON.stringify(message.error))); else job.resolve(message.result);
        }
      } else if (message.id !== undefined) {
        // All variants have the same non-interactive permissions. Escalations
        // are denied; a missing human reply is never fabricated.
        const result = message.method?.endsWith("requestApproval") ? { decision: "decline" } : undefined;
        this.send(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: "Evaluation has no interactive input" } });
      }
      this.notify(message); this.events.emit("message");
    });
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear(); this.events.emit("message");
  }
  async open() {
    if (this.failure) throw this.failure;
    if (this.ws.readyState !== WebSocket.OPEN) await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.ws.off("open", opened); this.ws.off("error", failed); this.ws.off("close", closed); };
      const opened = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => failed(new Error("Native evaluation closed before initialization"));
      const timer = setTimeout(() => failed(new Error("Native evaluation connection timeout")), 10_000);
      this.ws.once("open", opened); this.ws.once("error", failed); this.ws.once("close", closed);
    });
    await this.request("initialize", { clientInfo: { name: "fenjue_task_evaluation", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized" });
  }
  send(message: NativeMessage) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  completed(turnId: string, timeoutMs: number): Promise<NativeMessage> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, message?: NativeMessage) => {
        clearTimeout(timer); this.events.off("message", check);
        if (error) reject(error); else resolve(message!);
      };
      const check = () => {
        const message = this.messages.find(m => m.method === "turn/completed" && m.params.turn.id === turnId);
        if (message) finish(undefined, message); else if (this.failure) finish(this.failure);
      };
      const timer = setTimeout(() => finish(new Error("Task wall-clock limit exceeded")), Math.max(1, timeoutMs));
      this.events.on("message", check); check();
    });
  }
  close() { this.ws.terminate(); this.fail(new Error("Evaluation stopped")); }
}
