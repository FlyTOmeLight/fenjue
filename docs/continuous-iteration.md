# 持续迭代与按需专家审查

日常采集用于发现问题；同一任务的对照执行用于判断改动是否有效。当前提供人工反馈、最近七天报告、日常重复失败自动审查，以及受控专家对照评测。

## 日常自动审查

在 `native` 中增加 `review` 即启用。省略 `review` 时关闭；公开示例保持未启用。以下是显式开启的配置示例：

```json
"review": {
  "model": "gpt-6-astra",
  "effort": "high",
  "maxReviewsPerTask": 3,
  "timeoutMs": 120000,
  "maxTokens": 12000,
  "maxToolCalls": 20
}
```

只在 auto 模式下触发。完整用户任务中，相同命令和失败输出在一次成功的文件改动后重复，且包含测试或断言失败时，主轮次结束后启动审查。识别到环境错误时不触发；同一命令随后通过时取消该触发。每任务最多三次，相同失败证据最多一次。审查次数随任务恢复保留。

专家在同一工作目录的隔离只读会话运行，禁止网络工具访问，关闭外部 MCP、网页搜索、委派、插件、hooks 和记忆。专家只收到当前任务要求、公开回答和失败证据，读取当前代码，不接收私有 reasoning。内部会话与审批不会显示在主聊天中。主会话随后自动获得审查意见，沿用原模型、权限和协作模式，核对证据、修正并自测。

新用户输入、会话切换、取消或进入 manual/shadow 会停止尚在运行的审查。自动修正开始后按普通 Codex 轮次取消。按 F8 → m 暂停后续自动审查；按 F8 → a 恢复。Plan 模式、上下文缺失或审查输入超过 48 KiB 时不自动启动。专家失败、超时或超过预算时记录原因，不发送修正请求。token 限制按上游用量事件中断，可能存在在途用量。

原生日志保存 `review-started`、`review-finished` 和 `review-revision`，关联原任务和父轮次，记录意见、耗时、用量及失败原因。自动修正的 `accepted` 原因为 `architect-revision`。周报单列审查次数、耗时和用量，总 token 包含专家；缺失用量保持未知。意见和执行完成均不自动认证质量，仍需人工反馈。

有自动审查的执行快照保留为审核素材，并标记不能直接顺序回放。其审查与修正是额外阶段，需要重建相应评测策略。方案和交付前审查目前仍由评测显式指定，不根据每轮结束自动推断。

代码或配置更新后，正常退出已有会话，再从原项目目录运行 `codex-fenjue resume --last`。本地验证命令为 `npm run verify:native:review`；增加 `-- --terminal` 验证真实终端界面。这些检查使用本地模拟模型，不发起远程调用。

## 日常反馈

在焚诀仓库运行：

```bash
npm run build
npm start -- feedback list
npm start -- feedback add --task TASK_ID --outcome accepted \
  --reviewer light --reason '约定的验收全部通过' --evidence '验收命令和结果'
npm start -- feedback add --task TASK_ID --outcome rework \
  --reviewer light --cause implementation --reason '结果顺序仍不对应输入' \
  --evidence '失败断言及复现条件'
```

使用 `list` 中真实的 `taskId`。命令合并重启和恢复后的原生任务，输出预览、轮次编号、提交路线、执行状态及反馈历史。旧 Responses 记录没有可靠任务编号，不进入报告。

`outcome` 是 `accepted`（接受当前结果）、`rework`（需要返工）、`blocked`（执行受阻）。`cause` 可选 `implementation`、`reasoning`、`requirements`、`environment`、`unknown`，默认未知。原因是人工判断，需用证据支持，不会触发自动升级。

只评价一轮时增加 `--turn TURN_ID`。轮次反馈不能认证整个任务。反馈以独立文件追加到 `.fenjue/feedback/`，保留历史。任务级最新反馈决定结果；后续又有新的用户轮次时，旧反馈不再认证新结果。原生 `completed`、模型自称完成及用户未回复均保持质量未知。

## 每周审核

```bash
npm start -- feedback report --days 7 --out .fenjue/review/week-2026-10-04.md
npm start -- feedback report --days 7 --out .fenjue/review/week-2026-10-04.json
```

报告包含任务结果、路线、低置信度原因、已记录耗时和请求 token，以及每个候选的日志和采集路径。范围是最近七天开始的轮次，另纳入期间新增反馈的任务。跨窗口任务的 token 保留未知；用量不换算订阅费用。耗时从原生接受轮次至完成，不含提交前分类等待。已有文件不会覆盖。

这是按需生成的最近七天报告，没有安装后台定时任务。可用 `--dir` 指定原生日志目录、`--capture-dir` 指定采集目录。没有采集文本也能汇总原生任务。

每次同时选择普通成功任务和偏差任务。第一批整理 10–20 个完整案例，覆盖机械修改、常规实现、故障排查和阶段切换。未知结果需核对后再标注。

用 `cases draft/export` 整理分类标签。用 `tasks draft/export` 整理带起始代码和独立验收的执行任务。其他项目需在 `capture.execution.projects` 登记明确路径。事后验收进入 calibration；新冻结验证集使用独立项目和预登记验收，见[任务评测](task-evaluation.md)。

每次只检验一个假设，例如“重复测试错误后，专家审查能否提高验收通过率”。先用开发数据调整规则，候选冻结后再用新任务验证。保存策略及评测证据，不按单个案例直接降低生产阈值。

## 专家实验

```bash
# 不调用模型，冻结快照并确认初始代码未通过验收。
npm run eval:tasks -- --suite evals/execution-pilot/architect.json --dry-run

# 确定预算后再运行真实 Jev/GPT 对照。
npm run eval:tasks -- --suite evals/execution-pilot/architect.json \
  --live --max-runs 24 --config fenjue.config.json --env-file /path/to/gateway.env
```

复用已看过的六个合成夹具，全部归入 calibration，不作为新冻结验证集。四种策略为：当前 Sol/Astra 路由、Sol 三档路由、Sol 实施加 Sol high 自审、Sol 实施加 Astra high 审查。报告相对当前路由配对。自审和专家审查采用相同阶段及任务预算，区分额外检查与不同模型的效果。

`advisor-auto` 策略指定 `advisorRoute`。任务用 `reviewCheckpoints` 指定节点：

| 节点 | 首版条件 |
| --- | --- |
| `plan` | 人工选定需要方案审查的任务；主会话先在只读轮次提出方案，专家审查后实施 |
| `repeated-error` | 相同命令及完整失败输出在一次可观察改动后重复，且包含测试或断言失败；排除已识别环境错误 |
| `final` | 人工选定需要交付审查的任务；最后一条预定输入完成后审查，再由主会话核对和修正 |

仅已提交的输入进入当时的审查，未来约束不会提前泄漏。机械任务默认不增加检查。每任务最多三次审查，同一失败证据最多一次。只在已完成轮次之间介入。主会话可能已在本轮解决错误，专家仍需核对当前状态。

专家使用隔离的原生只读会话，读取同一工作区，不接管主会话、不写代码、不调用分类器。评测器控制全部审查阶段；日常原生入口另支持上述重复失败触发。原生自动委派、插件、hooks 和记忆保持关闭；不同时引入 Luna 分工。

主会话负责实施。审查意见是建议。冻结在工作区外的验收器决定通过与否。验收仅在全部执行结束后运行，不把验收输出送给专家。

每个 run 保存 `reviews.json`：节点、模型、父轮次、专家会话、意见及触发证据。`result.json` 保存各会话用量、修正轮数和总耗时。总 token 包含主会话与全部专家；任一会话缺失则总量为 null。工具次数和预算也包含专家。`final-answer.txt` 仅保存主会话的交付回答，排除方案草稿与专家意见；不采集私有 reasoning。

比较验收通过率、失败类别、耗时和总用量。修正轮数是评测器发出的修正请求数，不是人工返工次数。专家提出问题不自动证明问题成立，需复现或独立验收支持。

## 发布候选规则

先确定目标类别、质量底线及允许的时间或用量增幅。冻结验证通过后，按类别决定是否启用审查。保留上一策略及证据。实验不改写日常 `fenjue.config.json` 或全局 Codex 配置，也不自动扩大模型池。

方案参考 [delost 的按需架构专家建议](https://x.com/thedelost/status/2105398038026195279)。只读权限字段已对照本机 Codex 0.160.0 schema；接口见 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。
