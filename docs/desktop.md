# Mac ChatGPT App 桌面接入

`fenjue desktop` 生成一个原生 App Server 包装器。App 通过 `CODEX_CLI_PATH` 启动它，并传入自己的参数和环境。焚诀在提交新轮次前选择模型和思考强度，后端仍使用 App 内置 Codex。

```text
进程关系：ChatGPT App → App 内置 Codex → Fenjue 路由子进程
协议流向：ChatGPT App ↔ Fenjue 路由子进程 ↔ App 内置 Codex → 模型
```

启动脚本先准备私有 FIFO，再用 `exec` 原位运行 App 内置 Codex，保留 App 分配的进程 ID 和直接父子关系；焚诀在单独的路由子进程中转发协议。这样可以保留 App 注入的桌面工具管道、插件配置与启动参数，也让工具继续按原来的进程身份接受 App 校验。`--version`、`debug models` 等非服务命令直接透传给内置 Codex。包装器只拦截 stdio `app-server`，不打开 TCP 监听端口。

## 启动

需要已经登录的 Mac ChatGPT App、Node.js 22.18+ 和分类器密钥。先完成仓库安装与构建，在仓库目录运行：

```bash
npm start -- desktop --config examples/desktop.json --env-file /path/to/gateway.env
```

示例使用 Vercel 上的 Jev 分类器，环境文件需包含 `AI_GATEWAY_API_KEY`。只读取配置所需的密钥变量，包装器中只保存文件路径，不写入密钥。示例启用自动模式，不配置容量重试、自动专家审查或额外会话采集。

启动命令会输出一条带 `CODEX_CLI_PATH` 的 App 启动命令：

1. 等待 App 正在执行的任务结束，再完全退出 ChatGPT App。
2. 在终端执行输出的完整命令。
3. 在 App 的本地 Codex 聊天里发起任务。云端或 SSH 主机不在此入口的验证范围内。

已运行的 App 不会自动获得新的环境变量。生成包装器不会退出或启动 App，也不修改 `~/.codex/config.toml`。包装器随 App 的后端连接启动和停止，无需另外保持网关进程。

默认 App 路径为 `/Applications/ChatGPT.app`。其他安装位置使用 `--app /path/to/ChatGPT.app`；调试其他 Codex 后端时使用 `FENJUE_CODEX_BIN`。桌面命令不接受 `--` 后的 CLI 操作或配置覆盖；参数由 App 提供。重新运行 desktop 命令会更新所选日志目录中的包装器，下次启动后端时生效。

## 确认路由与手动选择

路由日志与状态默认保存在 `.fenjue/desktop/`，可用 `--log-dir` 修改。和原生 CLI 一样，状态文件包含后续分类所需的任务文本与工具证据。

```bash
npm start -- status --log-dir .fenjue/desktop --watch
```

App 成功提交手动模型或思考强度设置后，焚诀暂停该聊天的自动选择。每个运行中的包装器会写入 `.fenjue/desktop/desktop-<PID>.json`，包含自己的控制 socket 和日志路径；进程退出后删除该文件。使用其中的 socket 恢复自动：

```bash
npm start -- routing auto --socket /path/from/desktop-PID.json
```

也支持 `manual`、`shadow`。控制对象是该包装器最近绑定或提交轮次的聊天，单纯切换可见标签页不一定改变它。命令需要先有已绑定的聊天；手动模式会持久化，重启不等于恢复自动。

验证自动切换可先在同一聊天发送简单任务，再发送涉及多个独立系统的设计任务：

```text
把字符串 fenjue 改成大写，只返回结果，不调用工具。
```

```text
[new] 请为订单服务、支付服务、库存服务三个独立系统比较至少两种跨服务一致性架构，权衡重复回调、乱序事件和补偿失败；约束是不得共享数据库。只用中文 120 字以内总结方案取舍，不调用工具。
```

`[new]` 只标识新任务，不指定模型。检查日志中 `accepted` 事件的 `reason` 应为 `classified`，模型由分类结果决定。不要依赖模型在回复里自报的名称；App 的选择器是否跟随路由更新，也要在界面中确认。

## 停止与恢复

退出 App 后，正常从访达或 Dock 打开 App 即恢复原来的连接方式；无需删除全局配置。App 管理内置后端的生命周期，路由子进程在输入关闭或后端退出后清理私有 FIFO、Unix socket 和控制文件；日志与任务状态保留。

## 故障排查

直接从终端运行 App 可执行文件时，终端会显示 App 的运行日志。一般的信息日志不代表错误，但连续出现 `dynamic_app_tools_peer_rejected`、`missing-code-signing-identity` 或 `Codex app tools pipe closed`，表示桌面工具连接失败，不能只通过重定向日志处理。

v0.5.0 的旧包装器把 Node 路由进程放在内置后端的父进程位置，自动选模可用，但会触发桌面工具的进程身份拒绝。修正后的启动器让内置 Codex 与 App 保持直接父子关系，路由进程不再成为桌面工具的祖先。更新代码并构建后，重新运行 `desktop` 命令生成包装器，再完全退出 App 并使用新入口启动；只重新构建不会更换已经运行的进程。

验收必须同时检查：两条不同复杂度消息均完成且自动选择不同路线；至少一个 `codex_app` 桌面工具实际调用成功；新启动后的 App 日志中没有上述签名拒绝。模型回复或模拟测试通过均不能代替桌面工具验收。

## 验证范围

入口依据是 ChatGPT 26.1007.71326 包内实际的 `CODEX_CLI_PATH` 调用路径，内置 Codex 为 0.162.0-alpha.17.2。这是版本相关的实现入口，尚未确认为官方稳定配置。

```bash
npm run verify:desktop
```

该命令使用生成的包装器和 App 内置 Codex，分类器和模型均为本机模拟服务，真实模型调用为零。验证 App 风格的参数、自动 Sol/Astra 切换、手动覆盖、恢复自动与退出清理，不操作 App 界面。启动器回归测试另外检查后端保持原 PID/PPID、桌面工具环境和参数透传，以及 EOF / SIGTERM 清理。

真实分类器与模型的协议验证需要明确运行以下命令，固定执行两轮模型任务，可能消耗订阅用量及分类器费用；测试结束后归档测试聊天：

```bash
npm run build
node dist/scripts/verify-native-router-live.js --desktop \
  --config examples/desktop.json --env-file /path/to/gateway.env
```

协议验证关闭插件和额外工具，测试路由与回复。App 内联调按上面的启动步骤发送消息，再核对路由日志与最终回答。

### 已完成的桌面实测

2026-10-15，在上述 App 与内置 Codex 版本上，由用户通过生成的启动入口打开 App，在同一个本地聊天发送两条示例消息。实际桌面路由日志记录：

| 任务 | 自动选择 | 结果 |
| --- | --- | --- |
| 字符串转大写 | Sol / low | 最终回答返回，轮次完成 |
| 跨服务一致性架构比较 | Astra / high | 最终回答返回，轮次完成 |

两轮均为 `mode: auto`、`reason: classified`，证明 App 聊天已进入焚诀并完成跨模型切换。这次使用 v0.5.0 旧包装器的验证未覆盖桌面工具，之后发现上述签名兼容问题，因此不能把这两轮结果视为完整桌面兼容验收。这项验证由用户操作界面，通过日志及聊天回复核验；未目视核对模型选择器是否同步显示，也未单独验收打开文件等桌面工具。环境与参数透传由离线测试覆盖。真实会话 ID、原始日志和个人环境路径保留在本地，不进入公开仓库。

### 修复版桌面工具验收

2026-10-15，用户使用修复版启动器正常重启 App。实际进程确认内置 Codex 直接以 App 为父进程，焚诀路由进程以该后端为父进程。新启动日志中的 `dynamic_app_tools_peer_rejected`、`missing-code-signing-identity`、`Codex app tools pipe closed` 和桌面 MCP 发现失败均为零。

通过真正的 `codex_app` 工具调用读取了本聊天的附件列表，路由状态中记录 `status: completed` 且无工具错误；打开本地验收文件的请求也被 App 接收，但返回 `queued`，因此不将它计为文件已显示。本轮 App 请求另记录自动分类选择 Sol/medium；修复版启动器的独立真实协议双轮确认 Sol/low → Astra/high，均返回最终回答并完成。

这些证据覆盖自动路由和桌面工具服务恢复；不表示所有桌面工具都已逐一测试。
