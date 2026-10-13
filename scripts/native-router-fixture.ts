// Offline TUI fixture around the production CLI and HTTP classifier adapter.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTmuxSession } from "../src/tmux.js";

const [stateFile, upstream] = process.argv.slice(2);
assert.ok(stateFile && upstream?.startsWith("http://127.0.0.1:"));
const temp = await mkdtemp(join(tmpdir(), "fenjue-native-router-")), home = join(temp, "home");
let session: Awaited<ReturnType<typeof startTmuxSession>> | undefined;
try {
  await mkdir(home); process.env.CODEX_HOME = home;
  await mkdir(join(temp, "source")); await writeFile(join(temp, "source/code.txt"), "before");
  await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(temp)}]\ntrust_level = "trusted"\n`);
  const bundled = JSON.parse((await promisify(execFile)(process.env.FENJUE_CODEX_BIN ?? "codex", ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024 })).stdout);
  const catalog = join(temp, "models.json"), config = join(temp, "config.json"), logDir = join(temp, "logs"), capture = join(temp, "capture");
  await writeFile(catalog, JSON.stringify({ models: bundled.models.filter((m: any) => ["gpt-6.1-sol", "gpt-6-astra"].includes(m.slug)) }));
  await writeFile(config, JSON.stringify({ version: 1, auth: "mock", upstream, catalog, defaultRoute: "balanced",
    routes: Object.fromEntries([["fast", "low"], ["balanced", "medium"], ["deep", "high"]].map(([role, effort]) => [role, { model: "gpt-6.1-sol", effort }])),
    rules: [], native: { expertModel: "gpt-6-astra" }, capture: { directory: capture,
      execution: { directory: join(temp, "execution-cases"), projects: [{ directory: temp, paths: ["source"] }] } },
    semantic: { provider: "kev", mode: "auto", model: "fixture-jev", endpoint: upstream + "/v1/systemone", roles: { fast: "fast", balanced: "balanced", deep: "deep" } },
  }));
  const legacyConfig = join(temp, "legacy.json"), legacy = JSON.parse(await readFile(config, "utf8"));
  delete legacy.native; await writeFile(legacyConfig, JSON.stringify(legacy));
  const settings = { sqlite_home: home, log_dir: home, "features.apps": false, "features.plugins": false,
    "features.remote_plugin": false, "features.hooks": false, "features.memories": false, "features.shell_snapshot": false,
    "features.multi_agent": false, "features.skip_host_skill_discovery": true, "features.unbounded_connection_retries": false,
    "tui.animations": false };
  for (const phase of [1, 2, 3, 4]) {
    const fresh = phase === 1 || phase === 3;
    session = await startTmuxSession([fileURLToPath(new URL("../src/cli.js", import.meta.url)), phase === 3 ? "codex" : "codex-native",
      "--config", phase === 3 ? legacyConfig : config, "--log-dir", logDir, "--",
      "-C", temp, ...(fresh ? ["-s", "read-only", "-a", "never"] : []), ...Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]),
      ...(fresh ? ["Implement a bounded feature"] : phase === 2 ? ["resume"] : ["resume", "--last"])]);
    await writeFile(stateFile + ".tmp", JSON.stringify({ temp, socket: session.socket, logDir, capture, executionCases: join(temp, "execution-cases"), phase }));
    await rename(stateFile + ".tmp", stateFile);
    process.exitCode = await session.attach();
    await session.close(); session = undefined;
    if (process.exitCode) break;
  }
} finally { await session?.close(); await rm(temp, { recursive: true, force: true }); }
