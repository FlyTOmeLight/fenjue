# 发布验证

## v0.5.0

日期：2026-10-15。在 macOS、Node.js 26.11.1 环境中，仅复制公开源码到干净临时目录，从锁文件重新安装依赖，不复制个人配置、会话、已有 node_modules 或 dist。桌面后端使用 ChatGPT 26.1007.71326 内置 Codex 0.162.0-alpha.17.2。

| 检查 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts` | 锁文件安装成功，依赖审计无已知漏洞 |
| `npm run check` | 通过 |
| `npm test` | 237/237 通过，无跳过 |
| `npm run verify:terminal` | 13 项验收通过，5 次本机请求，真实模型调用为零 |
| `npm run verify:desktop` | 自动 Sol/low、Astra/high、手动 Sol/medium、恢复自动 Astra/high 四轮通过；分类器调用 3 次，均为本机模拟 |
| 包装器生命周期 | 非服务命令透传、退出码、控制文件及 socket 清理通过 |
| `--help` / `--version` | 包含 desktop 命令，显示 fenjue 0.5.0 / 本机 Codex 0.162.1 |
| 原生分类离线评测 / 执行套件 dry-run | 3/3 声明路线符合；六任务起始验收通过预检，未执行真实模型评测 |
| 实现阶段原生协议回归 | 使用 App 内置 Codex，12 轮模拟测试覆盖跨模型、工具续接、审批、中断、恢复与压缩 |
| 真实包装器协议验证 | 最终 stdio 入口固定执行两轮，真实分类器选择 Sol/low 与 Astra/high，均返回最终回答并完成 |
| App 内人工联调 | 用户从生成入口启动 App，在同一聊天发送简单与跨服务设计任务；日志确认 auto / classified 的 Sol/low → Astra/high，均完成 |

本版新增 `desktop` 命令、stdio 包装器、桌面配置示例和验证入口。App 启动的包装器保留桌面工具环境、插件配置与参数，沿用内置 Codex 和已有登录，不修改全局 Codex 配置，也不打开 TCP 监听端口。

本轮发版检查没有新增真实模型调用，真实协议与 App 人工联调复用本次实现阶段的证据。它们验证接入及选模，不评价任务质量、费用收益；未目视核对选择器是否同步显示，也未单独验收打开文件等桌面工具。该入口取自当前 App 实现，不能视为官方稳定配置。真实会话、原始日志和密钥文件留在本地；远端 Node 22 / 24 / 26 的结果见仓库 [Actions](https://github.com/FlyTOmeLight/fenjue/actions)。

## v0.4.0

日期：2026-10-14。从仅包含公开源码的干净临时副本开始，在 macOS、Node.js 26.11.1、Codex CLI 0.162.1 环境验证；没有复制个人配置、会话记录或已构建产物。

| 检查 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts --offline` | 从锁文件安装成功 |
| `npm run check` | 通过 |
| `npm test` | 235/235 通过，无跳过 |
| `npm run verify:terminal` | 13 项终端验收通过，包括取消、退出码和 SIGTERM 清理 |
| `--help` 与 `--version` | 帮助及 0.4.0 / Codex 0.162.1 版本显示通过 |
| 原生分类离线评测与执行套件 dry-run | 3/3 声明路线符合；六任务起始验收通过预检 |
| `npm run verify:native`（主工作区） | 跨模型、工具续接、审批、中断、恢复和压缩通过 |

新增需求 auto 模式，将需求问题合入一次主分类请求；复杂实施可选 high，普通多步骤实施用 medium。单独选择模型，保留现有工作类型、风险和上下文最低档。回归覆盖完整问卷预算、非法答案保档、运行中路线固定、阶段降档、整体 shadow/manual，以及底栏实际升档说明。未调用真实模型，真实分类准确率和执行质量收益尚未验证。

## v0.3.2

日期：2026-10-13。从仅包含 Git 跟踪文件的干净临时副本开始，在 macOS、Node.js 26.11.1、Codex CLI 0.162.1 环境验证。

| 检查 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts` | 从锁文件安装成功 |
| `npm run check` | 通过 |
| `npm test` | 225/225 通过，无跳过 |
| `npm run verify:terminal` | 通过，包括退出与 SIGTERM 清理 |
| `--help` 与 `--version --config` | 帮助、0.3.2 版本与配置摘要通过 |
| 原生分类离线评测与执行套件 dry-run | 通过 |
| 长字符串脱敏回归 | 修复前超过子进程截止时间，修复后通过；凭据仍被遮盖 |
| 真实会话恢复 | 约 2.3 MB 保存状态脱敏耗时 12 ms，通过修复后的原生网关恢复耗时 226 ms |

修复凭据匹配正则在长普通字符串上的重复回溯，避免保存任务状态时占满 CPU、阻塞会话恢复与退出。只在词边界开始匹配凭据名称，保留已有凭据遮盖行为。本轮验证没有发送用户消息或新增真实模型调用；真实会话及采集数据不进入提交。远端 Node 22 / 24 / 26 结果见仓库 Actions。

## v0.3.1

日期：2026-10-13。仅从公开源码建立干净临时副本，在 macOS、Node.js 26.11.1、Codex CLI 0.162.1 环境验证，完成后删除临时副本。

| 检查 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts` | 从锁文件安装成功 |
| `npm run check` | 通过 |
| `npm test` | 224/224 通过，无跳过 |
| `npm run verify:terminal` | 通过 |
| `--help` 与 `--version --config` | 版本读取、双版本显示和配置摘要通过 |
| 原生分类离线评测与执行套件 dry-run | 通过 |

本版仅增加 CLI 版本与启动配置展示，不改变模型选择或容量恢复规则；没有新增真实模型调用。运行中的人工模式/模型覆盖以会话状态为准。远端 Node 22 / 24 / 26 结果见仓库 Actions。

## v0.3.0

日期：2026-10-13。环境：macOS、Node.js 26.11.1、Codex CLI 0.162.1、Python 3.9.6，已安装 tmux。

验证从只包含公开文件的全新临时目录开始，没有复制已有 node_modules、dist、个人配置或历史采集目录。

| 检查 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts` | 从锁文件安装成功 |
| `npm run check` | 通过 |
| `npm test` | 223/223 通过，无跳过 |
| `npm run verify:terminal` | 终端、底栏、复制、滚动、取消与清理通过 |
| `npm run verify:codex` | 实际 Codex 到本地模拟上游的工具续接与代理协议通过 |
| `npm run verify:native` | 原生跨模型、审批、中断、恢复及压缩通过 |
| `npm run verify:native:router` | 实际原生终端路由、底栏与交互通过 |
| `npm run verify:native:review` | 独立专家审查与自动修正通过 |
| `npm run verify:native:capacity` | 单次备用恢复通过 |
| `npm run verify:native:capacity -- --persistent` | 连续容量失败恢复、已有工具结果续做和取消通过 |
| `npm run verify:native:capacity -- --persistent --terminal` | 实际 Codex 终端显示恢复回答并接受下一次输入 |
| `npm start -- --help` | 通过 |
| 原生合成分类离线评测 | 3/3 声明路线符合 |
| 六任务执行套件 dry-run | 六个起始验收均为有效失败，计划 18 次执行 |
| 两任务原生执行套件 dry-run | 两个起始验收均为有效失败，计划 10 次执行 |
| 六任务上下文对照 dry-run | 六个起始验收均为有效失败，单次重复计划 18 次执行 |
| `judge result` 示例离线预检 | 通过 |

上述发版检查没有调用远程模型，不重新评价真实任务质量。此前完成的 36 次上下文对照结果见 [任务评测](task-evaluation.md#2026-10-13-完整对照结果)；与发版验证分别记录。

公开文件已检查个人路径、会话 ID、私钥和常见 token 格式，没有命中；本地 Markdown 文件链接有效。该检查不等于全面的凭据识别保证。真实会话、历史结果、第三方虚拟环境和个人配置不进入 Git 提交。

GitHub CI 对 Node 22 / 24 / 26 运行常规检查及评测预检。远端实际结果以仓库 [Actions](https://github.com/FlyTOmeLight/fenjue/actions) 为准，不将本机检查结果当作远端成功。

首次 Linux CI 发现 tmux 信号字段在 Linux 为数字、macOS 为名称。已修正两种格式的退出码解析，并新增回归测试；修正后本机重新执行类型、全量测试与终端验收。
