import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { chmod } from "node:fs/promises";
import { WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Classify } from "./classification.js";
import { NativeSession, type NativeMessage } from "./native-session.js";
import { NativeRecords, type NativeEvent, type NativeMode } from "./native-records.js";

export async function startNativeGateway(options: {
  socket: string; executable: string; serverArgs: string[]; env: NodeJS.ProcessEnv;
  config: Config; records: NativeRecords; onEvent?: (event: NativeEvent) => void;
  classify?: Classify; initialManual?: boolean; onFailure: (error: Error) => void;
}) {
  let activeSession: NativeSession | undefined, connected = false, closed = false;
  const backends = new Map<ReturnType<typeof spawn>, Promise<void>>();
  const server = createServer((req, res) => {
    const mode = req.url?.match(/^\/mode\/(auto|manual|shadow)$/)?.[1] as NativeMode | undefined;
    if (req.method !== "POST" || !mode) { res.writeHead(404).end(); return; }
    try {
      if (!activeSession) throw new Error("Codex 尚未连接");
      activeSession.setMode(mode); res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(`焚诀模式：${mode}；下个新轮次生效\n`);
    } catch (error) { res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" }).end(String(error) + "\n"); }
  });
  const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
  wss.on("connection", ws => {
    if (connected || closed) { ws.close(1008, "One Codex client per gateway"); return; }
    connected = true;
    const backend = spawn(options.executable, ["app-server", ...options.serverArgs], {
      stdio: ["pipe", "pipe", "pipe"], env: options.env, shell: false,
    });
    let session: NativeSession;
    let failure = false, inputBytes = 0, outputBytes = 0;
    const fail = (error: Error) => {
      if (failure || closed) return;
      failure = true; session?.close(); options.onFailure(error); ws.terminate(); backend.kill("SIGTERM");
    };
    // Preserve ordered writes and pause producers at their native watermarks.
    // A bounded queue fails the connection instead of dropping protocol data.
    const sendServer = (message: NativeMessage) => {
      const line = JSON.stringify(message) + "\n";
      inputBytes += Buffer.byteLength(line);
      if (inputBytes > 64 * 1024 * 1024) { fail(new Error("原生输入队列超出限制")); return; }
      if (!backend.stdin.write(line, () => { inputBytes -= Buffer.byteLength(line); })) ws.pause();
    };
    backend.stdin.on("drain", () => ws.resume());
    const sendClient = (message: NativeMessage) => {
      if (ws.readyState !== ws.OPEN) return;
      const line = JSON.stringify(message), length = Buffer.byteLength(line);
      outputBytes += length;
      if (outputBytes > 64 * 1024 * 1024) { fail(new Error("原生输出队列超出限制")); return; }
      if (outputBytes > 1024 * 1024) backend.stdout.pause();
      ws.send(line, error => {
        outputBytes -= length;
        if (error) fail(error);
        if (outputBytes < 1024 * 1024) backend.stdout.resume();
      });
    };
    session = new NativeSession(options.config, options.records, sendServer, sendClient, options.onEvent, options.classify, options.initialManual);
    activeSession = session;
    const lines = createInterface({ input: backend.stdout });
    lines.on("line", line => {
      try { session.fromServer(JSON.parse(line)); }
      catch { fail(new Error("无法处理原生 App Server 消息")); }
    });
    ws.on("message", data => {
      try { void session.fromClient(JSON.parse(data.toString())).catch(fail); }
      catch { fail(new Error("无法处理原生 Codex 消息")); }
    });
    // Drain stderr without copying prompt/auth diagnostics into the case corpus.
    backend.stderr.resume();
    backend.stdin.on("error", fail); backend.once("error", fail); ws.on("error", fail);
    backends.set(backend, new Promise<void>(resolve => backend.once("close", (code, signal) => {
      lines.close(); session?.close();
      if (!closed && ws.readyState === ws.OPEN) {
        fail(new Error(`原生 App Server 已退出（${code ?? signal}）`)); ws.close();
      }
      backends.delete(backend); resolve();
    })));
    ws.once("close", () => {
      // The resume picker disconnects before the TUI opens a new transport.
      connected = false; activeSession = undefined;
      session.close(); backend.kill("SIGTERM");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socket, resolve); });
  await chmod(options.socket, 0o600);
  return { endpoint: `unix://${options.socket}`, async close() {
    closed = true; activeSession?.close();
    for (const ws of wss.clients) ws.terminate();
    for (const backend of backends.keys()) backend.kill("SIGTERM");
    const timer = setTimeout(() => { for (const backend of backends.keys()) backend.kill("SIGKILL"); }, 3000);
    try { await Promise.all(backends.values()); } finally { clearTimeout(timer); }
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
