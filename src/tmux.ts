import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RouteStatus, NativeRouteStatus } from "./status.js";
import type { Event } from "./proxy.js";
import type { NativeEvent } from "./native-records.js";

const exec = promisify(execFile);
const config = `
set -g status on
set -g status-position bottom
set -g status-style 'bg=colour236,fg=colour252'
set -g status-format[0] ' 焚诀 | 等待模型请求'
set -g status-interval 0
# Relay the application's title to the outer terminal (including cmux tabs).
set -g set-titles on
set -g set-titles-string '#{pane_title}'
set -g default-terminal tmux-256color
set -g focus-events on
set -s extended-keys on
set -s escape-time 10
set -g prefix None
set -g prefix2 None
unbind-key -a -T root
set -g mouse on
# The root table was cleared above; restore drag selection alongside scrolling.
bind-key -n MouseDrag1Pane if-shell -F -t = '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -M'
bind-key -n WheelUpPane if-shell -F -t = '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -e -t =; send-keys -M'
bind-key -n WheelDownPane send-keys -M
set -g remain-on-exit on
set-hook -g pane-died 'detach-client -s fenjue'
set-hook -g client-attached 'if-shell -F "#{pane_dead}" "detach-client"'
`;

// Respect Codex's root options before deciding whether its first positional
// argument is a noninteractive subcommand or a starting prompt.
export function interactiveCodex(args: string[]): boolean {
  const withValue = new Set(["-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
    "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox",
    "-C", "--cd", "--add-dir", "-a", "--ask-for-approval"]);
  const commands = new Set(["exec", "e", "review", "agents", "login", "logout", "mcp", "plugin", "app-server",
    "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug", "apply", "queue", "archive",
    "delete", "migrate-rollouts", "unarchive", "cloud", "features", "help", "exec-server"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["--help", "-h", "--version", "-V", "--json"].includes(arg)) return false;
    if (arg === "--") return true;
    if (withValue.has(arg)) { i++; continue; }
    if (!arg.startsWith("-")) return !commands.has(arg);
  }
  return true;
}

export function paneExitCode(status: string, signalName: string): number {
  const signal = `SIG${signalName.toUpperCase()}` as NodeJS.Signals;
  // tmux uses sys_signame on macOS; Linux builds report the signal number.
  const signalNumber = /^\d+$/.test(signalName) ? Number(signalName) : constants.signals[signal];
  return status ? Number(status) : 128 + (signalNumber ?? 1);
}

export async function startTmuxSession(argv: string[]) {
  try { await exec("tmux", ["-V"], { timeout: 5000 }); }
  catch { throw new Error("底栏需要 tmux；macOS 可运行 brew install tmux，或使用 --no-bar 关闭底栏"); }
  const temp = await mkdtemp(join(tmpdir(), "fenjue-ui-"));
  const socket = join(temp, "socket"), configPath = join(temp, "tmux.conf"), entry = join(temp, "argv.json");
  const env: NodeJS.ProcessEnv = { ...process.env, FENJUE_TMUX_SOCKET: socket };
  // Always own a separate server, even when launched from an existing tmux pane.
  delete env.TMUX; delete env.TMUX_PANE;
  const abort = new AbortController();
  let interrupted = 0, closing: Promise<void> | undefined;
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const handler = () => { interrupted = 128 + constants.signals[signal]; abort.abort(); };
    process.on(signal, handler);
    return { signal, handler };
  });
  const command = (args: string[]) => exec("tmux", ["-u", "-S", socket, ...args], { env, timeout: 5000, signal: abort.signal });
  const close = () => closing ??= (async () => {
    try {
      await exec("tmux", ["-S", socket, "kill-server"], { env, timeout: 5000 });
    } catch (error) {
      // A server may already have stopped, including failed startup.
      if ((error as { code?: unknown }).code !== 1) throw error;
    } finally {
      for (const { signal, handler } of handlers) process.off(signal, handler);
      await rm(temp, { recursive: true, force: true });
    }
  })();
  try {
    await writeFile(configPath, config, { mode: 0o600 });
    // User prompts never enter tmux's command parser. Only controlled paths do.
    await writeFile(entry, JSON.stringify(argv), { mode: 0o600 });
    await command(["-f", configPath, "new-session", "-d", "-s", "fenjue", "-x", String(process.stdout.columns || 100),
      "-y", String(process.stdout.rows || 30), "--", process.execPath, fileURLToPath(new URL("./tmux-entry.js", import.meta.url)), entry]);
    return {
      socket,
      async attach(): Promise<number> {
        try {
          const code = await new Promise<number>((resolve, reject) => {
            const client = spawn("tmux", ["-u", "-S", socket, "attach-session", "-t", "fenjue"], {
              env, stdio: "inherit", shell: false, signal: abort.signal,
            });
            client.once("error", reject);
            client.once("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] : 1)));
          });
          if (interrupted) return interrupted;
          if (code) return code;
          const state = (await command(["display-message", "-p", "-t", "fenjue:0.0", "#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}"])).stdout.trim().split(":");
          if (state[0] !== "1") return 130; // Client detached before Codex exited.
          const result = paneExitCode(state[1] ?? "", state[2] ?? "");
          // Keep startup/CLI errors readable after tmux restores the shell screen.
          if (result > 0 && result < 128) {
            const output = (await command(["capture-pane", "-p", "-t", "fenjue:0.0", "-S", "-20"])).stdout.trimEnd();
            if (output) process.stderr.write(output + "\n");
          }
          return result;
        } catch (error) {
          if (interrupted) return interrupted;
          throw error;
        }
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

export function createTmuxDisplay(socket: string) {
  const status = new RouteStatus();
  let updates = Promise.resolve(), closed = false, failure: unknown;
  return {
    onEvent(event: Event) {
      if (closed || !status.update(event)) return;
      // Both tmux formats (#) and status-line strftime (%) must stay literal.
      const line = " " + status.line(true).replaceAll("#", "##").replaceAll("%", "%%");
      updates = updates.then(async () => {
        if (failure) return;
        try { await exec("tmux", ["-S", socket, "set-option", "-g", "status-format[0]", line], { timeout: 2000 }); }
        catch (error) { failure = error; }
      });
    },
    async close() {
      closed = true;
      await updates;
      if (failure) throw new Error("焚诀底栏更新失败，路由记录仍可通过 status 查看", { cause: failure });
    },
  };
}

export async function createNativeTmuxDisplay(socket: string, controlSocket: string) {
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  // run-shell displays stdout in copy-mode; successful controls are already
  // acknowledged by the status bar and must leave the composer focused.
  const action = (mode: string) => "run-shell " + quote([process.execPath, cli, "routing", mode, "--socket", controlSocket].map(quote).join(" ") + " > /dev/null");
  await exec("tmux", ["-S", socket, "bind-key", "-n", "F8", "display-menu", "-T", "焚诀路由", "-x", "C", "-y", "S",
    "自动（下轮生效）", "a", action("auto"), "固定当前选择", "m", action("manual"), "观察建议", "s", action("shadow")], { timeout: 2000 });
  let updates = Promise.resolve(), closed = false, failure: unknown;
  const status = new NativeRouteStatus();
  return {
    onEvent(event: NativeEvent) {
      if (closed || !status.update(event)) return;
      const line = ` ${status.line()} | F8 路由菜单`.replaceAll("#", "##").replaceAll("%", "%%");
      updates = updates.then(async () => {
        if (failure) return;
        try { await exec("tmux", ["-S", socket, "set-option", "-g", "status-format[0]", line], { timeout: 2000 }); }
        catch (error) { failure = error; }
      });
    },
    async close() { closed = true; await updates; if (failure) throw new Error("原生路由底栏更新失败", { cause: failure }); },
  };
}
