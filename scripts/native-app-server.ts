import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

// Integration-test driver. Production routing does not depend on this client.
export type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: any };
export class NativeAppServer {
  readonly messages: Message[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  stderr = "";
  private sequence = 0;
  private events = new EventEmitter();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private failure?: Error;
  private exited: Promise<void>;
  onRequest?: (message: Message) => Promise<unknown>;

  constructor(executable: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      let message: Message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error("App Server emitted invalid JSON")); return; }
      this.messages.push(message);
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(Number(message.id));
        if (pending) {
          this.pending.delete(Number(message.id)); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
          else pending.resolve(message.result);
        }
      } else if (message.id !== undefined && message.method) {
        Promise.resolve().then(() => {
          if (!this.onRequest) throw new Error(`Unexpected server request: ${message.method}`);
          return this.onRequest(message);
        }).then(result => this.send({ id: message.id, result }), error => {
          this.send({ id: message.id, error: { code: -32603, message: String(error) } });
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
      }
      this.events.emit("message");
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-6000); });
    this.child.stdin.on("error", error => this.fail(error));
    this.child.once("error", error => this.fail(error));
    this.exited = new Promise(resolve => this.child.once("close", (code, signal) => {
      lines.close(); this.fail(new Error(`App Server exited: ${code ?? signal}`)); resolve();
    }));
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.events.emit("message");
  }
  send(message: Message) { this.child.stdin.write(JSON.stringify(message) + "\n"); }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "fenjue_verification", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized" });
  }
  waitFor(predicate: (message: Message) => boolean, from = 0, timeoutMs = 30_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: Message) => {
        clearTimeout(timer); this.events.off("message", check);
        if (error) reject(error); else resolve(result!);
      };
      const check = () => {
        const found = this.messages.slice(from).find(predicate);
        if (found) finish(undefined, found); else if (this.failure) finish(this.failure);
      };
      const timer = setTimeout(() => finish(new Error("Native event timeout")), timeoutMs);
      this.events.on("message", check); check();
    });
  }
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}

export function nativeOverrides(settings: Record<string, unknown>): string[] {
  return Object.entries(settings).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}
