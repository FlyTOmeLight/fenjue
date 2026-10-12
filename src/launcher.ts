import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, constants } from "node:os";
import { join, resolve } from "node:path";
import { AUTO_MODEL, type Config } from "./config.js";
import { buildCatalog } from "./catalog.js";
import { startProxy } from "./proxy.js";
import { createTitleDisplay } from "./status.js";
import { createTmuxDisplay } from "./tmux.js";
import { createCapture } from "./capture.js";

const exec = promisify(execFile);
export async function loadCatalog(config: Config, executable: string) {
  const raw = config.catalog ? await readFile(config.catalog, "utf8") :
    (await exec(executable, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 })).stdout;
  return buildCatalog(JSON.parse(raw), config);
}
export function codexOverrides(config: Config, url: string, catalogPath: string): string[] {
  const entries: Record<string, string | boolean> = {
    model: AUTO_MODEL, model_provider: "fenjue", model_catalog_json: catalogPath,
    "model_providers.fenjue.name": "Fenjue",
    "model_providers.fenjue.base_url": url,
    "model_providers.fenjue.wire_api": "responses",
    "model_providers.fenjue.supports_websockets": false,
    "model_providers.fenjue.requires_openai_auth": config.auth === "chatgpt",
    "features.enable_request_compression": false,
    "features.reasoning_effort_override": false,
  };
  if (config.auth !== "chatgpt") entries["model_providers.fenjue.env_key"] = config.auth === "mock" ? "FENJUE_MOCK_KEY" : "OPENAI_API_KEY";
  return [
    ...Object.entries(entries).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]),
    "-c", 'model_providers.fenjue.env_http_headers={ "x-fenjue-token" = "FENJUE_PROXY_TOKEN" }',
  ];
}
export async function launch(config: Config, args: string[], options: { executable?: string; logDir?: string; title?: boolean; tmuxSocket?: string } = {}): Promise<number> {
  const executable = options.executable ?? process.env.FENJUE_CODEX_BIN ?? "codex";
  const catalog = await loadCatalog(config, executable);
  const temp = await mkdtemp(join(tmpdir(), "fenjue-"));
  const logDir = resolve(options.logDir ?? ".fenjue");
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  let display: ReturnType<typeof createTitleDisplay> | ReturnType<typeof createTmuxDisplay> | undefined;
  try {
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const run = `${Date.now()}-${process.pid}`;
    const logPath = join(logDir, `route-${run}.jsonl`);
    await writeFile(logPath, "", { mode: 0o600, flag: "wx" });
    const catalogPath = join(temp, "models.json");
    await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    const captureSecrets = ["OPENAI_API_KEY", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", config.semantic?.apiKeyEnv]
      .flatMap(key => key && process.env[key] ? [process.env[key]!] : []);
    const capture = config.capture ? createCapture(config.capture.directory, run, captureSecrets,
      () => { process.stderr.write("[fenjue] 本轮任务采集写入失败，已停止采集；Codex 会话继续。\n"); }) : undefined;
    proxy = await startProxy(config, catalog, event => {
      try { appendFileSync(logPath, JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n"); }
      catch { process.stderr.write("[fenjue] 无法写入路由日志\n"); }
      display?.onEvent(event);
    }, undefined, capture?.observe);
    // The token is available before Codex (and its tools) can make any request.
    captureSecrets.push(proxy.token);
    process.stderr.write(`[fenjue] ${config.semantic ? `${config.semantic.provider === "kev" ? "Kev" : "Jev"} ${config.semantic.mode === "shadow" ? "观察" : "自动路由"}模式（${config.semantic.model}）` : "固定规则模式"}；路由记录：${logPath}\n`);
    if (capture) process.stderr.write(`[fenjue] 本地任务采集：${capture.path}（含脱敏后的用户与工具文本，待人工审核标注）\n`);
    if (config.semantic) {
      const s = config.semantic;
      process.stderr.write(`[fenjue] 分类上下文发送到 ${s.endpoint}；${s.apiKeyEnv ? `认证读取 ${s.apiKeyEnv}，未设置时保留路线并标记 missing-key` : "无需分类服务密钥"}。\n`);
    }
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const overrides = codexOverrides(config, proxy.url, catalogPath);
    if (options.tmuxSocket) {
      // Keep transcript output in tmux's scrollback so wheel bindings can reach it.
      overrides.push("-c", 'tui.alternate_screen="never"');
      display = createTmuxDisplay(options.tmuxSocket);
    } else if (options.title !== false && interactive && process.stderr.isTTY && process.env.TERM !== "dumb") {
      // Empty selections disable native title writes; the proxy owns this title.
      overrides.push("-c", "tui.terminal_title=[]");
      display = createTitleDisplay(text => { process.stderr.write(text); });
    }
    // Put overrides in the selected subcommand's scope: Codex exec has its own
    // config layer, which can replace provider tables from the root scope.
    const delimiter = args.indexOf("--");
    const childArgs = delimiter < 0 ? [...args, ...overrides] :
      [...args.slice(0, delimiter), ...overrides, ...args.slice(delimiter)];
    const child = spawn(executable, ["--no-daemon", ...childArgs], {
      stdio: "inherit", shell: false,
      env: { ...process.env, FENJUE_PROXY_TOKEN: proxy.token, ...(config.auth === "mock" ? { FENJUE_MOCK_KEY: "local-fixture-only" } : {}) },
    });
    let timer: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      child.kill(signal);
      timer ??= setTimeout(() => child.kill("SIGKILL"), 3000);
      timer.unref();
    };
    // A terminal sends SIGINT to the foreground process group. Codex must keep
    // its normal Ctrl-C-to-cancel behavior; do not kill the session after 3 s.
    const interrupt = () => { if (!interactive) terminate("SIGINT"); };
    const stop = () => terminate("SIGTERM");
    const hangup = () => terminate("SIGHUP");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", hangup);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] : 1)));
      });
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", hangup);
      if (timer) clearTimeout(timer);
    }
  } finally {
    try { if (proxy) await proxy.close(); }
    finally {
      try { await display?.close(); }
      finally { await rm(temp, { recursive: true, force: true }); }
    }
  }
}
