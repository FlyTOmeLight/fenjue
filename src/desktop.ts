import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// Only intercept the known stdio service invocation. CLI commands, app-server
// subcommands and unrecognized future switches retain the original behavior.
export function desktopServerIndex(args: string[]): number {
  const values = new Set(["-c", "--config", "--enable", "--disable", "--code-mode-host", "--listen",
    "--ws-auth", "--ws-token-file", "--ws-token-sha256", "--ws-shared-secret-file", "--ws-issuer", "--ws-audience", "--ws-max-clock-skew-seconds"]);
  const switches = new Set(["--strict-config", "--stdio", "--analytics-default-enabled"]);
  let command = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, equal = arg.indexOf("="), flag = equal < 0 ? arg : arg.slice(0, equal);
    if (values.has(flag)) {
      const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
      if (!value || (flag === "--listen" && value !== "stdio://")) return -1;
    } else if (switches.has(arg)) continue;
    else if (arg === "app-server" && command < 0) command = i;
    else return -1;
  }
  return command;
}

// The launcher execs the backend in place; the router must not become an
// ancestor of the App's signed desktop-tool processes.
export async function prepareDesktop(options: {
  configFile: string; envFile?: string; appPath?: string; executable?: string; logDir?: string;
}) {
  const appPath = resolve(options.appPath ?? "/Applications/ChatGPT.app");
  const executable = options.executable ?? process.env.FENJUE_CODEX_BIN ?? join(appPath, "Contents/Resources/codex-cli/bin/codex");
  const appExecutable = join(appPath, "Contents/MacOS/ChatGPT");
  await access(executable); await access(appExecutable);
  const directory = resolve(options.logDir ?? ".fenjue/desktop");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const launcher = join(directory, "codex-desktop");
  const args = [process.execPath, fileURLToPath(new URL("./desktop-proxy.js", import.meta.url)), "prepare", executable,
    resolve(options.configFile), options.envFile ? resolve(options.envFile) : "", directory, "--"];
  await writeFile(launcher, `#!/bin/sh
set -eu
umask 077
runtime_dir=$(mktemp -d "\${TMPDIR:-/tmp}/fenjue-desktop.XXXXXX")
trap 'rm -rf "$runtime_dir"' EXIT
${args.map(shellQuote).join(" ")} "$runtime_dir" "$@"
. "$runtime_dir/launch.sh"
`, { mode: 0o700 });
  return { launcher, launchCommand: `env -u CODEX_APP_SERVER_WS_URL -u CODEX_APP_SERVER_FORCE_CLI CODEX_CLI_PATH=${shellQuote(launcher)} ${shellQuote(appExecutable)}` };
}
