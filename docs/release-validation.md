# 发布验证

日期：2026-10-13。环境：macOS、Node.js 26.11.1、Codex CLI 0.162.1、Python 3.9.6，已安装 tmux。

验证从只包含公开文件的全新临时目录开始，没有复制已有 node_modules、dist、个人配置或历史采集目录。

| 检查 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts` | 从锁文件安装成功 |
| `npm run check` | 通过 |
| `npm test` | 185/185 通过，无跳过 |
| `npm run verify:terminal` | 终端、底栏、复制、滚动、取消与清理通过 |
| `npm run verify:codex` | 实际 Codex 到本地模拟上游的工具续接与代理协议通过 |
| `npm run verify:native` | 原生跨模型、审批、中断、恢复及压缩通过 |
| `npm start -- --help` | 通过 |
| 原生合成分类离线评测 | 3/3 声明路线符合 |
| 六任务执行套件 dry-run | 六个起始验收均为有效失败，计划 18 次执行 |
| 两任务原生执行套件 dry-run | 两个起始验收均为有效失败，计划 10 次执行 |
| `judge result` 示例离线预检 | 通过 |

上述检查没有调用远程模型，不重新评价真实任务质量。

公开文件已检查个人路径、会话 ID、私钥和常见 token 格式，没有命中；本地 Markdown 文件链接有效。该检查不等于全面的凭据识别保证。真实会话、历史结果、第三方虚拟环境和个人配置不进入 Git 提交。

GitHub CI 对 Node 22 / 24 / 26 运行常规检查及评测预检。远端实际结果以仓库 [Actions](https://github.com/FlyTOmeLight/fenjue/actions) 为准，不将本机检查结果当作远端成功。
