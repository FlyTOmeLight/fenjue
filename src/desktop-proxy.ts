import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseEnv, promisify } from "node:util";
import WebSocket from "ws";
import { readConfig } from "./config.js";
import { ExecutionCapture } from "./execution-capture.js";
import { nativeArguments } from "./native-launcher.js";
import { startNativeGateway } from "./native-gateway.js";
import { validateNativeCatalog } from "./native-policy.js";
import { NativeRecords } from "./native-records.js";
import { desktopServerIndex } from "./desktop.js";

async function main(): Promise<number> {
  const [executable, configFile, envFile, logDir, separator, ...args] = process.argv.slice(2);
  if (!executable || !configFile || !logDir || separator !== "--") throw new Error("Invalid desktop launcher arguments");
  const command = desktopServerIndex(args);
  if (command < 0) {
    const child = spawn(executable, args, { stdio: "inherit", env: process.env });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const handlers = signals.map(signal => () => { child.kill(signal); });
    signals.forEach((signal, i) => process.on(signal, handlers[i]!));
    try {
      const [code, signal] = await once(child, "exit");
      return code ?? 128 + (constants.signals[signal as keyof typeof constants.signals] ?? 1);
    } finally { signals.forEach((signal, i) => process.off(signal, handlers[i]!)); }
  }
  const config = await readConfig(configFile), key = config.semantic?.apiKeyEnv;
  if (envFile && key) {
    const value = parseEnv(await readFile(envFile, "utf8"))[key];
    if (!value) throw new Error(`指定环境文件未设置 ${key}`);
    process.env[key] = value;
  }
  if (key && !process.env[key]) throw new Error(`缺少分类器密钥 ${key}；请设置环境变量或使用 --env-file`);
  const catalog = config.catalog ? await readFile(config.catalog, "utf8") :
    (await promisify(execFile)(executable, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 })).stdout;
  validateNativeCatalog(JSON.parse(catalog), config);
  const secrets = ["OPENAI_API_KEY", key].flatMap(name => name && process.env[name] ? [process.env[name]!] : []);
  const warn = (message: string) => process.stderr.write(`[fenjue] ${message}\n`);
  const execution = config.capture?.execution ? new ExecutionCapture(config.capture.execution, secrets, warn) : undefined;
  const records = new NativeRecords(logDir, config.capture?.directory, secrets, warn, undefined, execution);
  const env = { ...process.env, ...(config.auth === "mock" ? { FENJUE_NATIVE_FIXTURE_KEY: "local-fixture-only" } : {}) } as NodeJS.ProcessEnv;
  if (key && key !== "OPENAI_API_KEY") delete env[key];
  delete env.CODEX_CLI_PATH;
  const temp = await mkdtemp(join(tmpdir(), "fenjue-desktop-")), socket = join(temp, "app.sock");
  const controlPath = join(logDir, `desktop-${process.pid}.json`);
  let gateway: Awaited<ReturnType<typeof startNativeGateway>> | undefined, ws: WebSocket | undefined;
  let failure: Error | undefined, stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  const fail = (error: Error) => { failure ??= error; stop(); };
  const lines = createInterface({ input: process.stdin });
  // Do not consume App's initialize request while the backend is starting.
  lines.pause();
  const drain = () => ws?.resume();
  process.stdout.on("drain", drain);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  signals.forEach(signal => process.on(signal, stop));
  try {
    gateway = await startNativeGateway({ socket, executable, serverArgs: [],
      backendArgs: [...args.slice(0, command + 1), ...nativeArguments(config, []).server, ...args.slice(command + 1)],
      env, config, records, onFailure: fail });
    await writeFile(controlPath, JSON.stringify({ pid: process.pid, socket, log: records.logPath }) + "\n", { mode: 0o600 });
    ws = new WebSocket(`ws+unix://${socket}:/`);
    ws.on("error", fail); ws.once("close", stop);
    ws.on("message", data => {
      if (!process.stdout.write(data.toString() + "\n")) ws!.pause();
    });
    process.stdout.on("error", fail);
    await once(ws, "open");
    lines.on("line", line => {
      if (ws!.readyState !== WebSocket.OPEN) return;
      if (ws!.bufferedAmount > 64 * 1024 * 1024) { fail(new Error("桌面输入队列超出限制")); return; }
      ws!.send(line, error => { if (error) fail(error); });
    });
    lines.once("close", stop); lines.resume();
    warn(`桌面 ${config.semantic!.mode} 路由；控制信息：${controlPath}`);
    await stopped;
    if (failure) throw failure;
    return 0;
  } finally {
    lines.close(); process.stdin.pause();
    signals.forEach(signal => process.off(signal, stop));
    process.stdout.off("drain", drain); process.stdout.off("error", fail);
    ws?.terminate(); await gateway?.close();
    await rm(controlPath, { force: true }); await rm(temp, { recursive: true, force: true });
  }
}
main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`[fenjue] ${error.message}\n`); process.exitCode = 1;
});
