# 兼容性与验证范围

源码要求 Node.js 22.18+。交互底栏依赖独立安装的 tmux，终端验证依赖 Python 3。当前实现包含 Unix PTY 和 tmux 路径；Windows 原生环境尚未验证。

## 两个执行入口

`codex-native` 使用本机 Codex App Server 按轮次提交真实模型和 effort。Codex 负责该模型的提示、工具和上下文。原生入口需要 semantic 分类配置；配置专家模型时支持跨模型选择。

`codex` 的交互会话在配置含 `native` 时走原生入口；exec / review 使用 Responses 代理。代理只改写 `fenjue-auto` 请求，跨模型仍需通过请求契约校验。

原生入口不支持 `--profile`、`--oss`、自选 `--remote` 和 `--worktree`。原生 remote resume 不支持通过 CLI 参数覆盖既有权限，恢复时保留原会话权限。

## 检查入口

| 命令 | 需要 Codex | 模型服务 |
| --- | --- | --- |
| `npm run check` / `npm test` | 否 | 本地模拟 |
| `npm run verify:terminal` | 否 | 本地模拟；需要 tmux、Python 3 |
| `npm run verify:codex` | 是 | 本地模拟 |
| `npm run verify:native` | 是 | 本地模拟 |
| `npm run verify:native:terminal` | 是 | 本地模拟；需要 tmux、Python 3 |
| `npm run verify:native:router` | 是 | 本地模拟；需要 tmux、Python 3 |

带 `--live` 或名称含 `:live` 的入口会调用真实服务，不属于无费用检查。

历史原生接入曾在 Codex 0.159.3 / 0.160.0 验证；最近完整任务实验使用 0.162.1。版本号描述已有证据，不代表自动保证其他版本兼容。启动不硬编码版本白名单；升级 Codex 后应运行相应协议检查。

GitHub CI 检查 Node 22 / 24 / 26 的类型、单元及终端行为，不运行付费模型评测。实际发布检查结果见 [发布验证](release-validation.md)。
