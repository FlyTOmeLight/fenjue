import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("CLI reports both versions and configured routing without launching a session", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "fenjue-cli-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const executable = join(cwd, "codex-fixture");
  await writeFile(executable, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '--version') process.exit(2); console.log('codex-cli fixture');`, { mode: 0o700 });
  const env = { ...process.env, FENJUE_CODEX_BIN: executable };
  for (const flag of ["--version", "-V", "--help"]) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve("dist/src/cli.js"), flag], { cwd, env, timeout: 5000 });
    assert.equal(stderr, "");
    if (flag === "--help") {
      assert.ok(stdout.startsWith(`焚诀 ${version}：`));
      assert.ok(stdout.includes("fenjue --version"));
    } else assert.equal(stdout, `fenjue ${version}\ncodex-cli fixture\n`);
  }
  const config = JSON.parse(await readFile(resolve("examples/native-balanced.json"), "utf8"));
  config.semantic.mode = "auto";
  Object.assign(config.native, { capacityFallback: "bidirectional", capacityRetry: "until-available", reasoningDemand: "shadow" });
  const configPath = join(cwd, "config.json"); await writeFile(configPath, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath,
    [resolve("dist/src/cli.js"), "--version", "--config", configPath], { cwd, env, timeout: 5000 });
  for (const text of ["auto / balanced-native-v6", "gpt-6.1-sol", "gpt-6-astra", "上下文 task", "bidirectional / until-available", "shadow（影子建议不改变选档）"]) assert.ok(stdout.includes(text), text);
  await assert.rejects(() => promisify(execFile)(process.execPath, [resolve("dist/src/cli.js"), "--version"],
    { cwd, env: { ...env, FENJUE_CODEX_BIN: join(cwd, "missing-codex") }, timeout: 5000 }),
    (error: any) => error.code === 1 && /无法读取 Codex 版本.*ENOENT/.test(error.stderr));
});
