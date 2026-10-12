# Fenjue · 焚诀

Task-aware model and reasoning routing for the Codex CLI.

Fenjue 使用任务分类器判断当前工作阶段，再为 Codex 选择模型和思考强度。它保留原生工具、审批和会话恢复流程，并提供路由日志、合成任务评测与 Codex Judge 判分入口。

**状态：实验性 0.2.0。** 当前提供源码安装，尚未发布 npm 包。模型名称是配置示例，是否可用由你的账号和 Codex 模型目录决定。现有评测尚未证明自动路由能提高任务质量或降低费用。

## 能做什么

- 根据当前阶段选择主模型的 low / medium / high，或显式配置的专家模型。
- 在同一任务内随阶段升降档；正在执行的轮次与工具续接保持路线固定。
- 支持 `shadow`（只观察）、`auto`（自动选择）、`manual`（固定选择）。
- 为分类保留任务目标、最新请求及工具证据；压缩分类视图不改写 Codex 的执行历史。
- 通过程序验收与独立模型判分比较完整任务，保留 fail 和 unknown。

## 安装

需要 Node.js **22.18+**、npm，以及已安装并登录的 Codex CLI。交互底栏和 F8 菜单需要 tmux；Python 3 用于终端验证。

```bash
git clone https://github.com/FlyTOmeLight/fenjue.git
cd fenjue
npm ci --ignore-scripts
npm run build
npm start -- --help
```

Fenjue 不安装 Codex，也不提供模型账号。登录方式沿用本机 Codex。

## 第一次启动：观察路由

```bash
cp examples/native-balanced.json fenjue.config.json
```

该配置使用 Vercel 网关上的 Jev 分类器。通过环境变量提供自己的密钥，再启动：

```bash
export AI_GATEWAY_API_KEY='你的网关密钥'
npm start -- codex-native --config fenjue.config.json
```

默认 `shadow` 只记录建议，执行使用当前路线；分类器仍会收到任务内容并产生调用费用。也可以使用 `--env-file /path/to/gateway.env` 读取指定密钥。需要本地分类器时，参考 [配置指南](docs/daily-use.md)。

将配置的 `semantic.mode` 改为 `auto` 后重新启动，即可自动选择。配置中的 `native.expertModel` 开启专家模型；设为 `"native": {}` 时只选择主模型的三档思考强度。

交互时按 **F8 → a / m / s** 切换自动、手动和观察模式。`/model` 会暂停自动路由；切换从下一个新轮次生效。没有底栏时，使用启动输出提供的 `routing` 控制命令。

```bash
npm start -- status --watch
```

## 不使用语义分类器的入口

```bash
npm start -- codex --config examples/single-model.json
```

该示例只使用固定前缀规则：普通新任务使用 medium，以 `[deep]` 开头使用 high，不自动判断复杂度。Codex 参数放在 `--` 后，例如：

```bash
npm start -- codex --config examples/single-model.json -- exec "检查这个项目"
```

原生路由与 Responses 入口的支持范围见 [兼容性说明](docs/compatibility.md)。

## 数据与费用

Codex 的执行内容交给你配置的模型服务。语义分类器还会收到当前请求、任务目标和选取的历史及工具证据；远程分类器属于额外的数据接收方。`shadow` 也会调用分类器。

原生入口即使未配置 `capture`，也会在 `.fenjue/` 保存路由日志和用于恢复的任务状态；任务状态含任务文本与工具证据，应作为私有材料保存。

公开示例不开启会话与代码快照采集。配置 `capture` 后，采集内容可能包含用户输入、回答、工具输出和指定项目的代码；脱敏不能保证移除全部敏感内容。默认本地输出 `.fenjue/`、个人配置和环境文件已被 Git 忽略，分享其他目录中的材料前也需检查内容。

自动路由不保证节省费用。真实任务评测、模型审核和专家审查会额外消耗账号用量；带 `--live` 的评测需要明确指定调用或运行次数预算。

## 验证与评测

常规检查使用本地模拟服务，无需模型密钥：

```bash
npm run check
npm test
npm run verify:terminal
```

`npm test` 未安装 tmux 时会跳过相关集成用例；终端验证必须安装 tmux 和 Python 3。安装 Codex 后可运行额外的本地协议验证：

```bash
npm run verify:codex
npm run verify:native
```

评测默认不请求远程模型：

```bash
npm run eval:native:classifier -- --config examples/native-balanced.json
npm run eval:tasks -- --dry-run
npm start -- judge result --input examples/judge-quality.json \
  --out .fenjue/review/quality-preflight.json
```

离线分类评测使用声明标签检查路由规则，不能当作分类准确率。完整执行方法见 [任务评测](docs/task-evaluation.md)，模型审核方法见 [Codex Judge](docs/model-judge.md)。

最近一次 24 次完整任务实验的公开摘要见 [质量结果](docs/evaluation-results.md)。该实验未显示新版的质量或效率收益；原始日志留在本地，公开摘要不能独立复现其历史版本对照。

## 文档与贡献

- [配置、启动与恢复](docs/daily-use.md)
- [运行环境和兼容性](docs/compatibility.md)
- [合成分类与执行用例](evals/README.md)
- [反馈与专家审查](docs/continuous-iteration.md)
- [贡献指南](CONTRIBUTING.md)

代码采用 [MIT 许可证](LICENSE)。独立安装组件和设计参考见 [NOTICE](NOTICE)。
