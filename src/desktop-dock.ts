import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const label = "io.github.flytomelight.fenjue.desktop-env";
const exec = promisify(execFile);
// Keep the macOS boundary explicit so tests never change the user's GUI session.
export interface DockSystem {
  platform: string;
  home: string;
  uid: number;
  run(file: string, args: string[]): Promise<string>;
}
const system = (): DockSystem => ({
  platform: process.platform, home: homedir(), uid: process.getuid?.() ?? -1,
  run: async (file, args) => (await exec(file, args, { timeout: 10_000 })).stdout,
});
const xml = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);

function paths(os: DockSystem) {
  if (os.platform !== "darwin") throw new Error("Dock 安装与卸载仅支持 macOS");
  return { agent: join(os.home, "Library/LaunchAgents", `${label}.plist`), domain: `gui/${os.uid}`, service: `gui/${os.uid}/${label}` };
}
async function readAgent(agent: string): Promise<string | undefined> {
  try { return await readFile(agent, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function installedLauncher(os: DockSystem, agent: string, contents: string | undefined) {
  if (contents === undefined) return undefined;
  const data = JSON.parse(await os.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", agent]));
  const args = data.ProgramArguments;
  if (data.Label !== label || !Array.isArray(args) || args.length !== 4 || args[0] !== "/bin/launchctl" || args[1] !== "setenv" || args[2] !== "CODEX_CLI_PATH" || typeof args[3] !== "string") {
    throw new Error(`登录任务格式不匹配，请先检查 ${agent}`);
  }
  return args[3] as string;
}
async function loaded(os: DockSystem, service: string) {
  try { await os.run("/bin/launchctl", ["print", service]); return true; }
  catch (error) { if ((error as { code?: number }).code === 113) return false; throw error; }
}

export async function installDesktopDock(launcher: string, os = system()) {
  const { agent, domain, service } = paths(os);
  launcher = resolve(launcher);
  await access(launcher, constants.X_OK);
  const previous = await readAgent(agent);
  const oldLauncher = await installedLauncher(os, agent, previous);
  const current = (await os.run("/bin/launchctl", ["getenv", "CODEX_CLI_PATH"])).trimEnd();
  if (current && current !== launcher && current !== oldLauncher) {
    throw new Error("GUI 环境已有其他 CODEX_CLI_PATH，未覆盖；请先取消原有入口后重试");
  }
  const wasLoaded = await loaded(os, service);
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${xml(launcher)}</string></array>
<key>RunAtLoad</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
`;
  await mkdir(dirname(agent), { recursive: true });
  if (wasLoaded) await os.run("/bin/launchctl", ["bootout", service]);
  try {
    await writeFile(agent, contents, { mode: 0o600 });
    await chmod(agent, 0o600);
    await os.run("/bin/launchctl", ["bootstrap", domain, agent]);
    // Set synchronously as well: RunAtLoad may not have finished when bootstrap returns.
    await os.run("/bin/launchctl", ["setenv", "CODEX_CLI_PATH", launcher]);
  } catch (error) {
    try {
      if (await loaded(os, service)) await os.run("/bin/launchctl", ["bootout", service]);
      if (previous !== undefined) {
        await writeFile(agent, previous, { mode: 0o600 });
        if (wasLoaded) await os.run("/bin/launchctl", ["bootstrap", domain, agent]);
      } else await rm(agent, { force: true });
      await os.run("/bin/launchctl", current ? ["setenv", "CODEX_CLI_PATH", current] : ["unsetenv", "CODEX_CLI_PATH"]);
    } catch (rollback) {
      throw new Error(`Dock 安装失败，恢复原配置也失败，请检查 ${agent}：${(rollback as Error).message}`, { cause: error });
    }
    throw error;
  }
  return agent;
}

export async function uninstallDesktopDock(os = system()) {
  const { agent, service } = paths(os);
  const launcher = await installedLauncher(os, agent, await readAgent(agent));
  if (await loaded(os, service)) await os.run("/bin/launchctl", ["bootout", service]);
  const current = (await os.run("/bin/launchctl", ["getenv", "CODEX_CLI_PATH"])).trimEnd();
  // Leave any entry installed by another tool untouched.
  if (launcher && current === launcher) await os.run("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
  await rm(agent, { force: true });
  return { agent, preservedEnvironment: Boolean(current && current !== launcher) };
}
