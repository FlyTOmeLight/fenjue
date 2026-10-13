# 完整任务对比

`eval:tasks` 从相同代码快照启动独立原生 Codex 会话，执行预先约定的用户输入，再运行工作区外的验收脚本。固定策略和自动策略都经过生产 `NativeSession`；不使用旧 `Router` 的三角色分类结果替代执行质量。

首批 `evals/execution-pilot/suite.json` 是 **6 个合成代码任务**，用于打通流程：文档替换、CSV 解析、异步并发故障、分页服务协作、乱序投影故障和多轮 Unicode 约束。它不是日常真实任务集，不据此扩大自动池。

## 运行

```bash
npm run eval:tasks -- --dry-run
```

默认也是 dry-run，不请求 Jev/GPT。它冻结任务集、验收脚本和代码快照，记录 SHA-256，并确认初始代码尚未通过验收。验收器崩溃、超时或初始代码已通过时，停止评测准备。

真实试运行使用已有 Codex 登录和本机分类器密钥：

```bash
npm run eval:tasks -- --live --max-runs 18 \
  --config fenjue.config.json --env-file /path/to/gateway.env
```

18 次代表 6 个任务 × 3 种策略的完整执行，会包含多次模型请求和工具调用。每个任务的时间、工具次数和 token 上限写在任务集里；token 上限按原生用量通知触发中断，是软上限，在途请求可能超过它。没有精确美元或订阅额度预算保证。

如果自动策略因范围置信度不足未实际调用 Astra，可使用 `evals/execution-pilot/diagnostic.json` 在两个跨服务夹具上固定比较 Sol high、Astra medium、Astra high：

```bash
npm run eval:tasks -- --suite evals/execution-pilot/diagnostic.json \
  --live --max-runs 6 --config fenjue.config.json --env-file /path/to/gateway.env
```

这组复用任务用于定位模型差异，明确归为 calibration，不充当新冻结验证集。它不调用分类器，不能用其成绩宣称自动路由达标。

筛选单个任务或重复配对：

```bash
npm run eval:tasks -- --live --task cross-unknown --repeats 2 --max-runs 6 \
  --config fenjue.config.json --env-file /path/to/gateway.env
```

`--suite` 指定任务集；`--output` 指定一个尚不存在的输出目录。默认写入 `.fenjue/execution/<时间>/`。流程顺序轮换策略，各执行独立会话、不共享解题结果，不自动重试。基础设施异常时保存部分报告并停止后续执行。任务未通过验收则记录失败并继续，最终返回非零退出码。

批次进程退出后，可以用 `--resume` 和原输出目录执行尚未记录的任务：

```bash
npm run eval:tasks -- --suite evals/execution-pilot/context-comparison.json \
  --live --resume --repeats 2 --max-runs 27 \
  --config examples/native-balanced.json --env-file /path/to/gateway.env \
  --output .fenjue/context-comparison-live-integrated
```

这里的 27 只是已记录 9/36 次时的剩余预算示例。续跑保持原任务、策略、顺序和重复次数，成功、失败及超时都占用已执行的位置，不重跑它们。`--max-runs` 约束本次剩余尝试，不把新开整批当作免费重试。任务集、冻结文件、Codex 版本、配置或模型目录改变时拒绝续跑；发现运行目录尚未写入报告时，也先停止核对实际消耗。续跑前保存 manifest/report 检查点，并在 manifest 记录续跑时间和剩余次数。

任务达到 wall-clock 上限计为 `timeout`，不会因单轮等待的计时器先触发就当作基础设施故障停止整批。容量不足等服务错误仍保留为基础设施错误并停止后续执行。

初版运行器曾在 Codex 0.159.3 验证；升级后应重新运行兼容性检查。评测统一使用 workspace-write、approvalPolicy=never；审批请求被拒绝，交互提问不伪造用户回答。关闭插件、hooks、记忆和子代理，控制外部差异；这批结果适用于该受控环境，不能直接代表启用这些能力的日常任务。

## 固定路线、最新消息与任务上下文对照

`evals/execution-pilot/context-comparison.json` 复用上述六个代码夹具和验收器；两个诊断任务拆成分析、修复和核对三个轮次，分页协作任务增加核对轮次。比较三种策略：固定 Sol high、只看最新消息的 Sol/Astra 自动路由、使用任务上下文的 Sol/Astra 自动路由。两种自动策略使用相同分类器和模型/effort 策略，仅分类输入不同。它是上下文消融实验，不是 Magpie 的直接运行结果。

```bash
npm run eval:tasks -- --suite evals/execution-pilot/context-comparison.json --dry-run
npm run eval:tasks -- --suite evals/execution-pilot/context-comparison.json \
  --live --repeats 2 --max-runs 36 \
  --config examples/native-balanced.json --env-file /path/to/gateway.env
```

这批复用任务全部归为 calibration，不作为独立冻结验证集。实验关闭焚诀的容量 fallback 和自动专家审查，保留服务端重路由记录。报告以固定 high 为基线，分别统计执行 token、缓存输入 token、分类 token/耗时、任务验收和逐任务配对结果。分类规则中仍有“继续”沿用路线等共同路径，因此 latest-message 并非无状态路由。验收通过不等于独立模型质量判分通过；本命令不调用 Judge。

### 2026-10-13 完整对照结果

已完成 6 个任务 × 3 种策略 × 2 次，共 36 次真实执行。此前另一批的 1 次容量失败单独保留，累计消耗授权的 37 次尝试；没有重跑已记录的失败。可共享的逐次数据见 [context-comparison-results.json](../evals/native-routing/context-comparison-results.json)，原始 manifest、验收输出和日志保留在本机 `.fenjue/context-comparison-live-integrated/`。

| 策略 | 完成且验收通过 | 超时 | 总耗时（秒） | 执行总 token | 其中缓存输入 token | Jev 输入 token |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 固定 Sol high | 11/12 | 1 | 1828.4 | 2,859,283 | 2,490,240 | 0 |
| 仅最新消息 | 10/12 | 2 | 1661.0 | 2,782,900 | 2,495,104 | 70,426 |
| 任务上下文 | 12/12 | 0 | 1393.4 | 3,163,079 | 2,751,488 | 121,569 |

任务上下文相对固定 high 的验收配对是 1 胜、0 负、11 平；相对仅最新消息有 2 次避免超时。它的总耗时约少 24%，执行总 token 约多 11%，因此不能据此宣称更省费用。表中包含超时尝试；缓存输入已经包含在执行总 token 中，Jev 只记录输入 token，不是分类器总用量。

三次超时均超过任务的 240 秒上限：`local-diagnosis/latest-message/1`、`cross-unknown/fixed-sol-high/1` 和 `cross-unknown/latest-message/2`。第一次因单轮计时器先触发，被误记为基础设施错误；核对实际耗时后改为 timeout，原报告和该次 result 的备份仍保留。运行器修复了这个计时问题，并从已记录的 9 次之后续跑剩余 27 次。

这组结果支持继续保留任务上下文，但只有六个合成任务，不能证明日常质量等价，也不扩大模型准入。运行使用 Codex 0.162.1、Jev 和 `balanced-native-v6`；数据记录任务、配置、目录及部分源码哈希。两会话同时有其他代码工作，保留的源码快照不等于完整冻结仓库，复现时需同时核对实现版本。

## 任务格式

每个任务包含 `id`、`category`、`group`、`split`、`origin`、`snapshot`、`prompts`、`acceptance` 和 `limits`，见首批任务集。

- `snapshot` 是任务集目录内的子目录，放入任务开始前的代码。首版支持至多 20 MiB 的独立夹具，跳过 `.git`、`node_modules` 和 Codex 配置目录；拒绝符号链接和常见凭据文件。仍需人工检查文件内容，不能把真实密钥作为样例。
- `group` 标识相关任务或同一项目，不能同时出现于 calibration 和 holdout。冻结集不用于调整策略。
- `origin` 明确区分 synthetic 与 daily。日常对话记录不能代替开始时的代码快照，需要补齐起点和验收后才能成为执行任务。
- `prompts` 是预先写好的用户输入序列。每个策略使用自己的工具和助手历史；不能把其他策略的发现或最终答案当作后续输入。
- `acceptance.argv` 是无 shell 的命令数组，支持 `{suite}` 和 `{workspace}` 路径替换。验收脚本冻结在模型可写工作区外。只运行自己审核过的任务集。

验收器可通过 `FENJUE_WORKSPACE` 读取结果代码，通过 `FENJUE_FINAL_ANSWER` 读取最终回答。最后一行必须输出 JSON：`{"passed":true}` 且退出 0，或 `{"passed":false,"error":"原因"}` 且退出 1。其他输出/退出状态视为验收器异常。验收进程不继承分类/API key。

## 看报告

- `manifest.json`：冻结任务、快照文件哈希、策略、重复次数、Codex 版本和配置指纹；`catalog.json` 保存并固定该批次使用的原生模型目录。
- `preflight.json`：开始执行前的验收结果。
- `report.json`：各策略通过数、总耗时、用量及相对 Sol 自动策略的逐任务胜/负/平，同时统计采用/保留原因和专家模型实际提交轮数。基础设施异常单列，缺失用量保留 null；用量记录缓存命中，不换算精确订阅费用。
- `runs/<任务>-<策略>-<重复>/`：最终代码、变更文件哈希、最终回答、验收输出和原生路由日志。原生采集排除私有推理内容。

验收通过同时要求原生执行 completed 与验收器 passed；模型声称完成不能替代验收。报告为配对筛选结果，`admission` 固定为 `not-decided`，不会修改日常配置。预定多轮输入不是人工修正次数，当前报告也不声称测得用户满意度。

扩大自动池前，将合成夹具扩展为可复现的日常任务，预先确定关键约束和质量底线，保留独立冻结集，并为有差异的类别补充重复执行。按“任务类别 × 模型 × effort”审核准入，样本不足继续补充任务；不把少量任务全通过解释为质量等价。

## 从日常任务生成完整执行 case

`cases` 命令审核分类标签；新增的 `tasks` 命令审核完整执行任务。后者必须有执行前的代码、完整用户输入和独立验收。已有聊天记录缺少起始代码时，不能补拍快照并宣称是原始任务回放。

在原生交互入口的配置中增加明确的项目与路径：

```json
"capture": {
  "directory": ".fenjue/daily",
  "execution": {
    "directory": ".fenjue/execution-cases",
    "projects": [{ "directory": ".", "paths": ["src", "test", "package.json"] }]
  }
}
```

项目目录和输出目录相对于配置文件解析，`paths` 相对于项目目录。项目必须与原生会话的工作目录完全匹配；其他项目不会自动保存代码。目录中只复制指定路径，跳过 `.git`、`node_modules`、`.fenjue` 和 Codex 配置目录，拒绝符号链接、常见凭据文件、缺失路径及超过 20 MiB 的快照。代码保留原始字节用于回放；文本采集继续脱敏。发布前需人工检查代码内容。

为需要采集的项目添加目录及路径后重新启动。一个新任务的分类确认后、原生 `turn/start` 发送前保存快照；原生接受输入后再记录用户轮次。后续反馈和恢复会话追加到同一任务，起点不变。取消或拒绝的未接受轮次不留下正式素材，记录失败会标明不完整。只有可靠的新任务边界才保存新起点；若明确开始独立任务，可写 `[new] 完整任务描述`。缺少可靠历史的旧会话不会自动重建起点。任务分组不等于原生聊天历史被清空；审核时应确认描述可独立理解。依赖旧会话信息的任务不能直接拿单条输入回放。

在仓库目录查看已采集任务：

```bash
npm start -- tasks list
npm start -- tasks draft \
  --case .fenjue/execution-cases/daily-ID \
  --out .fenjue/review/execution-001.json
```

草稿不带模型建议、执行状态或自动质量标签。审核时检查同目录的 `items.jsonl` 和 `snapshot/`；填写 `review.reviewer`、`review.approved=true`、`task.category`，并设置 `task.acceptance={"verifier":"/absolute/path/verify.mjs","timeoutMs":30000}`。类别可用 `mechanical`、`feature`、`diagnosis`、`integration`、`architecture`；验收协议见上文。不要更改来源、项目分组或用户输入来冒充原始回放。预登记的草稿已经填写冻结验收路径。

```bash
npm start -- tasks export \
  --draft .fenjue/review/execution-001.json \
  --out .fenjue/datasets/execution-001
npm run eval:tasks -- \
  --suite .fenjue/datasets/execution-001/suite.json --dry-run
```

导出默认使用固定 Sol medium、Sol 自动、Sol/Astra 自动三种策略；可用 `--strategies 策略数组.json` 指定其他已支持组合。输出 `suite.json`、代码快照、独立验收及 `provenance.json`。需要人工批准、任务轮次已结束、快照和输入未变化；已有输出不会覆盖。非文本输入、改变语义的脱敏、未知上下文和执行中补充输入不支持直接顺序回放。

**事后补写验收的任务只进入 `calibration`。** 多轮记录中的反馈可能依赖原模型的回答，人工需确认它作为固定输入序列仍有意义；当前不能据此比较不同模型的实时人工返工次数。

### 执行前登记验收

若计划把一个新任务留作冻结验证，在提交首条任务前准备任务文本与验收脚本，并登记：

```bash
npm start -- tasks register --project /absolute/path/to/project \
  --prompt /absolute/path/task.txt --verifier /absolute/path/verify.mjs
```

`task.txt` 写首条完整输入，在 Codex 中提交相同文本，包含 `[new]` 等前缀；匹配只忽略首尾空白。该项目也必须在 `capture.execution.projects` 中登记。每次相同首条输入的任务会关联这一份预登记验收；相同登记不可覆盖。任务起始快照内复制验收文件并保存哈希，修改后不能继续称为原始预登记验收。

首版仅允许**单条预登记输入**的任务经人工审核后设置 `task.split=holdout`。多轮反馈任务仍进入 calibration。导出器检查同一任务集内的项目和会话不得跨两个集合；分批维护时也必须按这些分组隔离。因此焚诀项目一旦用于校准，就不应又拿它的相关任务当独立冻结验证；冻结集需选独立项目。`review.approved` 是人工声明，不是工具证明标注者身份的凭证。

### 当前回放范围

自动快照是待审核素材，不能证明项目环境已经可复现。首版执行器适合依赖已准备好的独立任务：不会复制 `node_modules`，也不会自动安装依赖、启动数据库或还原外部服务。需检查所选路径是否覆盖任务所需代码，并准备验收器与运行环境。缺少依赖导致的验收崩溃会在 dry-run 阶段停止。整批任务集文件仍受 20 MiB 上限约束，可拆成较小批次。

通过 dry-run 后才按上文运行 `--live --max-runs N`。日常采集、人工审核和 dry-run 都不会自动发起付费对比；真实回放报告不会自动扩大模型池。
