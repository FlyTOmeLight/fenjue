import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, constants } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import { mainRoute, validateNativeCatalog } from "./native-policy.js";
import { NativeRecords } from "./native-records.js";
import { startNativeGateway } from "./native-gateway.js";
import { NativeRouteStatus } from "./status.js";
import { ExecutionCapture } from "./execution-capture.js";
import { createNativeTmuxDisplay, interactiveCodex } from "./tmux.js";

const exec = promisify(execFile);
export function nativeArguments(config: Config, args: string[]) {
  if (!interactiveCodex(args)) throw new Error("codex-native 支持交互会话；exec/review 请使用 codex 入口");
  const shared: string[] = [];
  let manual = false, command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (["--remote", "--remote-auth-token-env", "--oss", "--local-provider", "--profile", "-p", "--worktree"].some(flag => arg === flag || arg.startsWith(flag + "="))) {
      throw new Error(`原生入口尚未验证 ${arg}；请直接用 Codex 执行该操作`);
    }
    if (["-c", "--config", "--enable", "--disable"].includes(arg)) {
      const value = args[++i]; if (!value) throw new Error(`${arg} 缺少值`);
      shared.push(arg, value);
      if (/^\s*(model|model_reasoning_effort)\s*=/.test(value)) manual = true;
    } else if (/^(--config|--enable|--disable)=/.test(arg)) {
      shared.push(arg);
      if (/^--config=\s*(model|model_reasoning_effort)\s*=/.test(arg)) manual = true;
    } else if (arg === "--model" || arg === "-m") { manual = true; i++; }
    else if (arg.startsWith("--model=")) manual = true;
    else if (["-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval", "--add-dir", "-i", "--image"].includes(arg)) i++;
    else if (!arg.startsWith("-") && command === undefined) command = arg;
  }
  // Root model overrides also override resumed native history. Defaults belong
  // only to new threads; an explicit user -m/-c still wins on resume.
  const entries: Record<string, unknown> = command === "resume" || command === "fork" ? {} :
    { model: mainRoute(config).model, model_reasoning_effort: mainRoute(config).effort };
  if (config.catalog) entries.model_catalog_json = config.catalog;
  if (config.auth === "mock") Object.assign(entries, {
    model_provider: "fenjue_native_fixture", "model_providers.fenjue_native_fixture.name": "Fenjue native fixture",
    "model_providers.fenjue_native_fixture.base_url": config.upstream,
    "model_providers.fenjue_native_fixture.wire_api": "responses",
    "model_providers.fenjue_native_fixture.env_key": "FENJUE_NATIVE_FIXTURE_KEY",
    "model_providers.fenjue_native_fixture.requires_openai_auth": false,
    "model_providers.fenjue_native_fixture.supports_websockets": false,
    "features.enable_request_compression": false,
  });
  const defaults = Object.entries(entries).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
  return { server: [...defaults, ...shared], client: [...defaults, ...args], manual };
}

export async function launchNative(config: Config, args: string[], options: { executable?: string; logDir?: string; tmuxSocket?: string } = {}): Promise<number> {
  const executable = options.executable ?? process.env.FENJUE_CODEX_BIN ?? "codex";
  const catalog = config.catalog ? await readFile(config.catalog, "utf8") :
    (await exec(executable, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 })).stdout;
  validateNativeCatalog(JSON.parse(catalog), config);
  const forwarded = nativeArguments(config, args);
  const temp = await mkdtemp(join(tmpdir(), "fenjue-native-")), socket = join(temp, "app.sock");
  let gateway: Awaited<ReturnType<typeof startNativeGateway>> | undefined;
  let display: Awaited<ReturnType<typeof createNativeTmuxDisplay>> | undefined;
  let client: ReturnType<typeof spawn> | undefined;
  let failed: Error | undefined;
  try {
    const secrets = ["OPENAI_API_KEY", config.semantic?.apiKeyEnv].flatMap(key => key && process.env[key] ? [process.env[key]!] : []);
    const warn = (message: string) => process.stderr.write(`[fenjue] ${message}\n`);
    const execution = config.capture?.execution ? new ExecutionCapture(config.capture.execution, secrets, warn) : undefined;
    const records = new NativeRecords(resolve(options.logDir ?? ".fenjue"), config.capture?.directory, secrets, warn, undefined, execution);
    const env: NodeJS.ProcessEnv = { ...process.env, ...(config.auth === "mock" ? { FENJUE_NATIVE_FIXTURE_KEY: "local-fixture-only" } : {}) };
    const status = new NativeRouteStatus();
    // The classifier owns its key. Native Codex needs only its own credentials.
    if (config.semantic?.apiKeyEnv && config.semantic.apiKeyEnv !== "OPENAI_API_KEY") delete env[config.semantic.apiKeyEnv];
    gateway = await startNativeGateway({ socket, executable, serverArgs: forwarded.server, env, config, records,
      initialManual: forwarded.manual, onEvent: event => {
        display?.onEvent(event); status.update(event);
        if (!display && (event.type === "retrying" || event.type === "retry-failed" || (event.type === "completed" && event.status === "failed" && event.previousError))) {
          warn(status.line());
        }
      },
      onFailure: error => { failed = error; client?.kill("SIGTERM"); },
    });
    if (options.tmuxSocket) display = await createNativeTmuxDisplay(options.tmuxSocket, socket);
    process.stderr.write(`[fenjue] 原生 ${config.semantic!.mode} 路由；日志：${records.logPath}\n`);
    process.stderr.write(`[fenjue] 分类服务：${config.semantic!.endpoint}；/model 固定选择，F8 打开路由菜单。\n`);
    if (config.native?.review) process.stderr.write(`[fenjue] 自动专家审查：${config.native.review.model} / ${config.native.review.effort}；改动后重复测试失败触发，每任务最多 ${config.native.review.maxReviewsPerTask} 次。\n`);
    process.stderr.write(`[fenjue] 无底栏时可在另一终端执行：fenjue routing auto --socket ${socket}\n`);
    if (records.capturePath) process.stderr.write(`[fenjue] 本地任务采集：${records.capturePath}\n`);
    if (execution) process.stderr.write(`[fenjue] 执行 case 快照：${config.capture!.execution!.directory}；仅登记的项目与路径\n`);
    client = spawn(executable, ["--remote", gateway.endpoint, ...forwarded.client,
      ...(options.tmuxSocket ? ["--no-alt-screen"] : [])], { env, stdio: "inherit", shell: false });
    let timer: NodeJS.Timeout | undefined;
    const stop = () => { client!.kill("SIGTERM"); timer ??= setTimeout(() => client!.kill("SIGKILL"), 3000); timer.unref(); };
    // SIGINT reaches the TUI through the foreground process group. It owns
    // cancel-turn and double-Ctrl-C; the wrapper must not kill it on a timer.
    const interrupt = () => { if (!process.stdin.isTTY) stop(); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", stop); process.on("SIGHUP", stop);
    try {
      const code = await new Promise<number>((resolve, reject) => {
        client!.once("error", reject);
        client!.once("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] : 1)));
      });
      if (failed) throw failed;
      return code;
    } finally {
      process.off("SIGINT", interrupt); process.off("SIGTERM", stop); process.off("SIGHUP", stop);
      if (timer) clearTimeout(timer);
    }
  } finally {
    try { await gateway?.close(); }
    finally { try { await display?.close(); } finally { await rm(temp, { recursive: true, force: true }); } }
  }
}
