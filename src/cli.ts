#!/usr/bin/env node
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseEnv, promisify } from "node:util";
import { execFile } from "node:child_process";
import { readConfig } from "./config.js";
import { launch } from "./launcher.js";
import { latestLog, showStatus } from "./status.js";
import { interactiveCodex, startTmuxSession } from "./tmux.js";
import { casesCommand } from "./cases.js";
import { launchNative } from "./native-launcher.js";
import { nativeControl } from "./native-control.js";
import { tasksCommand } from "./execution-capture.js";
import { feedbackCommand } from "./feedback.js";
import { judgeCommand } from "./judge.js";
import { mainRoute, nativePolicy } from "./native-policy.js";

const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const help = `焚诀 ${version}：Codex 任务路由
用法：
  fenjue codex [--config 文件] [--env-file 文件] [--log-dir 目录] [--no-bar] [--no-title] -- [Codex 参数]
  fenjue codex-native [同上参数] -- [交互 Codex 参数]
  fenjue routing auto|manual|shadow --socket 本次启动显示的路径
  fenjue status [--watch] [--log 文件 | --log-dir 目录]
  fenjue cases list [--dir 采集目录]
  fenjue cases draft --file 采集文件 --thread ID --out 草稿.json
  fenjue cases export --draft 已审核草稿.json [--draft 更多草稿.json] --out 数据集.json [--format native --config 配置]
  fenjue judge cases --draft 草稿.json --out 模型审核.json [--live --max-calls N]
  fenjue judge result|compare --input 判分材料.json --out 判分结果.json [--live --max-calls N]
    judge 可指定 --model、--effort、--timeout-ms；默认离线预检
  fenjue tasks list [--dir 执行快照目录]
  fenjue tasks register --project 项目 --prompt 首条任务.txt --verifier 验收.mjs [--dir 执行快照目录]
  fenjue tasks draft --case 快照目录 --out 草稿.json
  fenjue tasks export --draft 已审核草稿.json [--draft 更多草稿.json] --out 新任务集目录
  fenjue feedback list [--dir 原生日志目录]
  fenjue feedback add --task ID --outcome accepted|rework|blocked --reviewer 姓名 --reason 具体原因 [--turn ID] [--cause 原因类型] [--evidence 证据]
  fenjue feedback report [--days 7] [--dir 原生日志目录] [--capture-dir 采集目录] [--out 周报.md或.json]
  fenjue --help
  fenjue --version [--config 文件]

默认配置：./fenjue.config.json
示例：
  fenjue codex --config examples/single-model.json
  fenjue codex --config examples/semantic-shadow.json
  fenjue codex --config examples/kev-shadow.json
  fenjue codex --config fenjue.config.json -- exec "检查这个项目"
  fenjue status --watch

交互 Codex 默认使用 tmux，在同一终端底部显示请求模型与强度。
--no-bar 关闭底栏；Responses 入口改用窗口标题，--no-title 可关闭焚诀标题。
原生入口保留 Codex 自带的 model/effort 显示；/model 固定选择，F8 → a 恢复自动。
配置 native: {} 自动启用原生交互入口；native.expertModel 选择跨系统路由模型。
native.rules 可按消息前缀显式指定模型和 effort，优先于普通 rules；手动模式仍优先。
native.review 配置自动只读审查；改动后相同测试再次失败时触发，auto 模式下生效。
exec、review、JSON 输出及非 TTY 不启用底栏。底栏需要本机安装 tmux。
status 默认读取 .fenjue 中最近启动的日志；--watch 持续跟踪该文件，Ctrl-C 退出。

未配置 semantic 时使用固定规则；semantic 支持 Jev / Kev 的 shadow 观察和 auto 自动路由。
TypeSafe 默认读取 TYPESAFE_API_KEY；Kev 可配置 endpoint，默认无需密钥。
任务上下文只发送到所选分类服务；分类失败时保留路线。尚未实现模型自动升级。
--env-file 只读取配置指定的分类器密钥，不加载文件中的其他环境变量。
capture.directory 采集会话文本；capture.execution 为指定项目保存执行前快照。
cases 支持人工或 Codex 模型审核，来源分开记录；tasks 导出仍需审核执行快照与独立验收。
judge 使用独立 Codex 会话，不自动改写人工反馈或默认路由配置。
`;
async function main(): Promise<number> {
  const tmuxSocket = process.env.FENJUE_TMUX_SOCKET;
  // Internal handoff applies only to this CLI, never to tools Codex may spawn.
  delete process.env.FENJUE_TMUX_SOCKET;
  const args = process.argv.slice(2);
  if (args[0] === "--version" || args[0] === "-V") {
    if (args.length !== 1 && (args.length !== 3 || args[1] !== "--config" || !args[2])) throw new Error("用法：fenjue --version [--config 文件]");
    process.stdout.write(`fenjue ${version}\n`);
    const executable = process.env.FENJUE_CODEX_BIN ?? "codex";
    try {
      const { stdout } = await promisify(execFile)(executable, ["--version"], { timeout: 5000 });
      process.stdout.write(`${stdout.trim()}\n`);
    } catch (error) {
      throw new Error(`无法读取 Codex 版本（${executable}）：${(error as NodeJS.ErrnoException).code ?? "执行失败"}`);
    }
    if (args[2]) {
      const config = await readConfig(resolve(args[2]));
      const semantic = config.semantic;
      if (!semantic || config.native === undefined) {
        process.stdout.write(`路由（启动配置）：${semantic?.mode ?? "固定规则"} / Responses 入口\n`);
      } else {
        const native = config.native;
        process.stdout.write([
          `路由（启动配置）：${semantic.mode} / ${nativePolicy(config)}`,
          `分类器：${semantic.model}；支持度阈值 ${semantic.minConfidence}；上下文 ${native.classifierContext ?? "task"}`,
          `主模型：${mainRoute(config).model}；专家模型：${native.expertModel ?? "未配置"}`,
          !native.expertModel ? "模型选择：仅使用主模型" : native.expertPolicy === "constraints" ? "模型选择：独立约束用主模型，耦合约束用专家" : "模型选择：局部/同项目多文件用主模型，跨独立系统用专家",
          "思考强度：机械且可逆用 low；实施用 medium；诊断/架构/根因未知/敏感逻辑用 high",
          "保留规则：支持度不足保留已有模型或档位；指代不清或缺少条件时不降档；首轮默认主模型 medium",
          ...(native.rules?.length ? [`显式路线：${native.rules.map(rule => `${rule.prefix} → ${rule.model} / ${rule.effort}`).join("；")}`] : []),
          `容量恢复：${native.capacityFallback ?? "off"} / ${native.capacityRetry ?? "once"}`,
          `推理需求：${native.reasoningDemand ?? "关闭"}（影子建议不改变选档）`,
          `专家审查：${native.review ? `${native.review.model} / ${native.review.effort}，每任务最多 ${native.review.maxReviewsPerTask} 次` : "关闭"}`,
          "运行中手动切换以会话状态为准；配置改动需重启生效",
        ].join("\n") + "\n");
      }
    }
    return 0;
  }
  if (!args.length || args[0] === "--help" || args[0] === "-h") { process.stdout.write(help); return 0; }
  const command = args.shift();
  if (command === "routing") {
    const [mode, flag, socket, extra] = args;
    if ((mode !== "auto" && mode !== "manual" && mode !== "shadow") || flag !== "--socket" || !socket || extra) throw new Error("用法：fenjue routing auto|manual|shadow --socket 路径");
    process.stdout.write(await nativeControl(socket, mode)); return 0;
  }
  if (command === "cases") { await casesCommand(args); return 0; }
  if (command === "tasks") { await tasksCommand(args); return 0; }
  if (command === "feedback") { await feedbackCommand(args); return 0; }
  if (command === "judge") { await judgeCommand(args); return 0; }
  if (command === "status") {
    let watch = false, log: string | undefined, logDir: string | undefined;
    while (args.length) {
      const flag = args.shift()!;
      if (flag === "--watch") { watch = true; continue; }
      if (flag !== "--log" && flag !== "--log-dir") throw new Error(`未知 status 参数 ${flag}`);
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少值`);
      if (flag === "--log") log = value; else logDir = value;
    }
    if (log && logDir) throw new Error("--log 与 --log-dir 只能选一个");
    const path = log ? resolve(log) : await latestLog(logDir);
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (watch) { process.on("SIGINT", stop); process.on("SIGTERM", stop); }
    try { await showStatus(path, { watch, signal: controller.signal, write: text => { process.stdout.write(text); } }); }
    finally { if (watch) { process.off("SIGINT", stop); process.off("SIGTERM", stop); } }
    return 0;
  }
  if (command !== "codex" && command !== "codex-native") throw new Error("未知命令，请运行 fenjue --help");
  let path = "fenjue.config.json", logDir: string | undefined, envFile: string | undefined;
  let title = true, bar = true;
  const forwarded: string[] = [];
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--") { forwarded.push(...args); break; }
    if (flag === "--no-title") { title = false; continue; }
    if (flag === "--no-bar") { bar = false; continue; }
    if (flag === "--config" || flag === "--log-dir" || flag === "--env-file") {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少值`);
      if (flag === "--config") path = value; else if (flag === "--env-file") envFile = value; else logDir = value;
    } else throw new Error(`未知焚诀参数 ${flag}；Codex 参数请放在 -- 后`);
  }
  const config = await readConfig(resolve(path));
  if (envFile) {
    const key = config.semantic?.apiKeyEnv;
    if (!key) throw new Error("--env-file 需要分类器配置 apiKeyEnv");
    const value = parseEnv(await readFile(resolve(envFile), "utf8"))[key];
    if (!value) throw new Error(`指定环境文件未设置 ${key}`);
    process.env[key] = value;
  }
  if (bar && !tmuxSocket && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb" && interactiveCodex(forwarded)) {
    const session = await startTmuxSession([resolve(process.argv[1]!), ...process.argv.slice(2)]);
    try { return await session.attach(); }
    finally { await session.close(); }
  }
  const native = command === "codex-native" || (config.native !== undefined && interactiveCodex(forwarded));
  return native ? launchNative(config, forwarded, { logDir, tmuxSocket }) : launch(config, forwarded, { logDir, title, tmuxSocket });
}
main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`[fenjue] ${error.message}\n`); process.exitCode = 1;
});
