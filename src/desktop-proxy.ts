import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseEnv, promisify } from "node:util";
import { readConfig } from "./config.js";
import { ExecutionCapture } from "./execution-capture.js";
import { nativeArguments } from "./native-launcher.js";
import { validateNativeCatalog } from "./native-policy.js";
import { NativeRecords, type NativeMode } from "./native-records.js";
import { NativeSession, type NativeMessage } from "./native-session.js";
import { desktopServerIndex, shellQuote } from "./desktop.js";

async function main(): Promise<number> {
  const [mode, executable, configFile, envFile, logDir, separator, runtime, ...args] = process.argv.slice(2);
  if (!executable || !configFile || !logDir || separator !== "--" || !runtime) throw new Error("Invalid desktop launcher arguments");
  const exec = promisify(execFile), inputPath = join(runtime, "backend-in"), outputPath = join(runtime, "backend-out");
  if (mode === "prepare" && desktopServerIndex(args) < 0) {
    // This helper exits before the shell execs; it never remains an ancestor.
    await writeFile(join(runtime, "launch.sh"), `rm -rf ${shellQuote(runtime)}\nexec ${[executable, ...args].map(shellQuote).join(" ")}\n`, { mode: 0o600 });
    return 0;
  }
  const config = await readConfig(configFile), key = config.semantic?.apiKeyEnv;
  if (!config.semantic) throw new Error("桌面原生路由需要 semantic 分类配置");
  if (envFile && key) {
    const value = parseEnv(await readFile(envFile, "utf8"))[key];
    if (!value) throw new Error(`指定环境文件未设置 ${key}`);
    process.env[key] = value;
  }
  if (key && !process.env[key]) throw new Error(`缺少分类器密钥 ${key}；请设置环境变量或使用 --env-file`);
  if (mode === "prepare") {
    const catalog = config.catalog ? await readFile(config.catalog, "utf8") :
      (await exec(executable, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 })).stdout;
    validateNativeCatalog(JSON.parse(catalog), config);
    await exec("mkfifo", ["-m", "600", inputPath, outputPath]);
    const command = desktopServerIndex(args);
    const backendArgs = [...args.slice(0, command + 1), ...nativeArguments(config, []).server, ...args.slice(command + 1)];
    const sidecar = [process.execPath, process.argv[1]!, "route", executable, configFile, envFile ?? "", logDir, "--", runtime];
    const backend = ["env", "-u", "CODEX_CLI_PATH", ...(key && key !== "OPENAI_API_KEY" ? ["-u", key] : []),
      ...(config.auth === "mock" ? ["FENJUE_NATIVE_FIXTURE_KEY=local-fixture-only"] : []), executable, ...backendArgs];
    await writeFile(join(runtime, "launch.sh"), `exec 3<&0 4>&1
${sidecar.map(shellQuote).join(" ")} "$$" <&3 >&4 3<&- 4>&- &
sidecar_pid=$!
trap 'kill "$sidecar_pid" 2>/dev/null || :; rm -rf "$runtime_dir"' EXIT
exec 3<&- 4>&-
exec ${backend.map(shellQuote).join(" ")} <${shellQuote(inputPath)} >${shellQuote(outputPath)}
`, { mode: 0o600 });
    return 0;
  }
  if (mode !== "route" || !/^\d+$/.test(args[0] ?? "")) throw new Error("Invalid desktop sidecar arguments");
  const backendPid = Number(args[0]), controlPath = join(logDir, `desktop-${backendPid}.json`), socket = join(runtime, "app.sock");
  const secrets = ["OPENAI_API_KEY", key].flatMap(name => name && process.env[name] ? [process.env[name]!] : []);
  const warn = (message: string) => process.stderr.write(`[fenjue] ${message}\n`);
  const execution = config.capture?.execution ? new ExecutionCapture(config.capture.execution, secrets, warn) : undefined;
  const records = new NativeRecords(logDir, config.capture?.directory, secrets, warn, undefined, execution);
  let failure: Error | undefined, stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  const fail = (error: Error) => { failure ??= error; stop(); };
  // Covers exec failure, backend signals and loss of our parent, including while
  // an asynchronous FIFO open is pending. No App process is killed by the router.
  const parentWatch = setInterval(() => {
    try { process.kill(backendPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") stop(); else fail(error as Error); }
  }, 250);
  const startup = setTimeout(() => fail(new Error("桌面后端管道启动超时")), 15_000);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  signals.forEach(signal => process.on(signal, stop));
  let backendInput: ReturnType<Awaited<ReturnType<typeof open>>["createWriteStream"]> | undefined;
  let backendOutput: ReturnType<Awaited<ReturnType<typeof open>>["createReadStream"]> | undefined;
  let clientLines: ReturnType<typeof createInterface> | undefined, backendLines: ReturnType<typeof createInterface> | undefined;
  let session: NativeSession | undefined, server: ReturnType<typeof createServer> | undefined;
  const drain = () => backendLines?.resume();
  try {
    const aborted = stopped.then(() => { throw failure ?? new Error("桌面后端在管道就绪前退出"); });
    // Pair with the shell's <backend-in >backend-out redirections in this order.
    backendInput = (await Promise.race([open(inputPath, "w"), aborted])).createWriteStream();
    backendOutput = (await Promise.race([open(outputPath, "r"), aborted])).createReadStream();
    clearTimeout(startup);
    let inputBytes = 0, outputBytes = 0;
    session = new NativeSession(config, records, (message: NativeMessage) => {
      const line = JSON.stringify(message) + "\n", length = Buffer.byteLength(line);
      inputBytes += length;
      if (inputBytes > 64 * 1024 * 1024) { fail(new Error("桌面输入队列超出限制")); return; }
      if (!backendInput!.write(line, error => { inputBytes -= length; if (error) fail(error); })) clientLines?.pause();
    }, (message: NativeMessage) => {
      const line = JSON.stringify(message) + "\n", length = Buffer.byteLength(line);
      outputBytes += length;
      if (outputBytes > 64 * 1024 * 1024) { fail(new Error("桌面输出队列超出限制")); return; }
      if (!process.stdout.write(line, error => { outputBytes -= length; if (error) fail(error); })) backendLines?.pause();
    });
    backendInput.on("error", fail); backendInput.on("drain", () => clientLines?.resume());
    backendOutput.on("error", fail); backendOutput.once("end", stop);
    process.stdout.on("error", fail); process.stdout.on("drain", drain);
    server = createServer((req, res) => {
      const mode = req.url?.match(/^\/mode\/(auto|manual|shadow)$/)?.[1] as NativeMode | undefined;
      if (req.method !== "POST" || !mode) { res.writeHead(404).end(); return; }
      try { session!.setMode(mode); res.writeHead(200).end(`焚诀模式：${mode}；下个新轮次生效\n`); }
      catch (error) { res.writeHead(409).end(String(error) + "\n"); }
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(socket, resolve); });
    await chmod(socket, 0o600);
    await writeFile(controlPath, JSON.stringify({ pid: backendPid, sidecarPid: process.pid, socket, log: records.logPath }) + "\n", { mode: 0o600 });
    backendLines = createInterface({ input: backendOutput });
    backendLines.on("line", line => { try { session!.fromServer(JSON.parse(line)); } catch { fail(new Error("无法处理桌面后端消息")); } });
    clientLines = createInterface({ input: process.stdin });
    clientLines.on("line", line => {
      try { void session!.fromClient(JSON.parse(line)).catch(fail); } catch { fail(new Error("无法处理桌面 App 消息")); }
    });
    clientLines.once("close", () => backendInput!.end());
    warn(`桌面 ${config.semantic.mode} 路由；控制信息：${controlPath}`);
    await stopped;
    if (failure) throw failure;
    if (!process.stdout.destroyed) await new Promise<void>(resolve => { process.stdout.write("", () => resolve()); });
    return 0;
  } finally {
    clearTimeout(startup); clearInterval(parentWatch);
    signals.forEach(signal => process.off(signal, stop));
    session?.close(); clientLines?.close(); backendLines?.close(); process.stdin.pause();
    process.stdout.off("drain", drain); process.stdout.off("error", fail);
    backendInput?.destroy(); backendOutput?.destroy();
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => { server!.close(() => resolve()); });
    await rm(controlPath, { force: true }); await rm(runtime, { recursive: true, force: true });
  }
}
// FIFO opens may still be pending when a failed exec or signal ends the session.
main().then(code => { process.exit(code); }).catch(error => {
  process.stderr.write(`[fenjue] ${error.message}\n`, () => process.exit(1));
});
