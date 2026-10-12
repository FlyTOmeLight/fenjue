# Codex 自动审核与结果判分

`judge` 使用已有 Codex 登录，在新建临时目录中启动独立、只读、ephemeral 的 Codex 进程。默认 Judge 为 `gpt-6-astra / high`，可用 `--model`、`--effort` 指定。它不继承用户配置和项目说明，关闭 MCP 配置加载、网页搜索、插件、记忆、hooks 和委派；不执行工具。临时文件在成功或失败后清理。

默认只预检输入。真实调用须增加 `--live --max-calls N`。分类每轮一次；结果判分一次；匿名对比交换顺序，共两次。每次默认超时 180 秒，`--timeout-ms` 可设置 1–600000 毫秒。单次提示上限为 240000 UTF-8 字节，超限直接报错，不静默截断。调用次数与超时不是精确 token 或费用上限。现有输出文件不会覆盖。

## 自动标注分类案例

先用 `cases draft` 从自己的本地采集记录生成草稿。下面的 `case.json` 需替换为该草稿：

```bash
npm run build
npm start -- judge cases \
  --draft .fenjue/review/case.json \
  --out .fenjue/review/judged-003.json

# 该草稿有一轮输入，真实审核一次。
npm start -- judge cases \
  --draft .fenjue/review/case.json \
  --out .fenjue/review/judged-003-live.json --live --max-calls 1
```

Judge 收到当前五题定义、约束题和截至当前轮次的输入与证据。旧标签、采集的实际路由及未来轮次不作为单独字段传入；原文中自行提及的模型名称仍可能影响判断。每轮返回 `pass/fail/unknown`、五项特征、约束标签、三档角色/effort、简短理由和证据引用。这里的 pass 表示标签可确定，不表示任务产物合格。

草稿存在压缩、恢复、非文本或其他上下文警告时，首版直接记录 unknown，不调用模型猜测。需要先重建可靠上下文或改用完整素材。不会自动删掉有警告的轮次。

模型审核保存至 `review.model`，包括请求模型、effort、规则版本、时间、输入及案例摘要、逐轮原始判定。`review.approved` 保持 false，`review.reviewer` 留空。全部轮次标注确定后可导出；unknown、无效标签或审核后修改的草稿会被拒绝。摘要用于检查记录是否变化，不认证审核者身份。模型标签是校准参考，不宣称是独立人工 golden set。

```bash
# 原生日常路由用这个格式，导出固定进入 calibration。
npm start -- cases export --draft .fenjue/review/judged-003-live.json \
  --format native --config fenjue.config.json \
  --out .fenjue/datasets/judged-native-003.json

npm run eval:native:classifier -- --config fenjue.config.json \
  --cases .fenjue/datasets/judged-native-003.json --policy baseline

# 旧三档分类口径仍支持默认格式。
npm start -- cases export --draft .fenjue/review/judged-003-live.json \
  --out .fenjue/datasets/judged-legacy-003.json
```

原生导出的 `features` 和 `constraints` 来自 Judge。`allowed` 是根据这些声明标签和当前两套策略推导的预期路线，来源标记为 `declared-policy`。该字段用于发现分类与策略符合度，不证明选中的模型具有最佳质量或成本。导出的来源保留模型审核记录；不把模型审核标成人工审核。实际模型收益由同任务的完整执行对照判断。

日常草稿的 `turn.evidence` 是该请求之前的证据，原生评测的同名字段是该轮之后的模拟输出。导出器将第二轮之前的证据放到第一轮之后，依次映射，避免分类器晚一轮看到历史。首轮之前已有证据的片段需先补齐会话起点，不能直接导出。

## 按标准判分结果

输入示例见 `examples/judge-quality.json`。填写原始 `requirements`、固定的 `criteria`、实际 `answer` 和 `evidence`。`executionStatus` 表示实际完成状态。`verification` 填独立测试的真实结果及输出；未执行或无法确认填 unknown，不能复制模型自称测试通过来填写 pass。

```bash
npm start -- judge result --input examples/judge-quality.json \
  --out .fenjue/review/quality-preflight.json

npm start -- judge result --input examples/judge-quality.json \
  --out .fenjue/review/quality-live.json --live --max-calls 1
```

每项标准必须返回唯一 id、状态、理由和证据引用。代码任务设置 `kind: "code"`：独立验收未通过时，Judge 不能认证通过。验收 fail 或任何标准 fail 使总体 fail；验收未知的代码、未完成执行、空答案或任何未知标准使总体 unknown。文本任务可以按已提供材料得到 pass，无需代码测试。

结果同时保存输入、摘要、请求 Judge 设置、Codex CLI 版本和原始判定。输入标准由调用方准备；入口不能证明它们是在任务执行前制定的，也不能证明传入的测试证据真实。正式对照应先冻结需求与验收，事后标准用于校准。

## 匿名成对比较

输入为两个结果材料的数组，二者的需求、标准和任务类型必须相同。示例见 `examples/judge-comparison.json`。

```bash
npm start -- judge compare --input examples/judge-comparison.json \
  --out .fenjue/review/comparison-live.json --live --max-calls 2
```

Judge 只收到匿名 A/B 材料，不传入顶层模型或路线字段。第二次交换顺序；换序后不一致则 winner=unknown。输出 A/B 指原始输入数组顺序，tie 表示质量相当。验收失败、未完成或未验收的代码不能被认证为胜者；这类好评归为 unknown。两次模型一致也不等于事实正确。

## 与现有流程的关系

模型判分不自动写入人工 `feedback accepted`，不更改日常路由或扩大模型池。`tasks export` 的执行素材审核仍沿用现有人工声明；Judge 结果可以提供审核证据，但本入口不自动认证起始快照、验收环境和预登记时间。

建议先用已知合格与不合格的少量案例检查判分器，再批量处理日常数据。没有人工抽查时，报告应称为模型参考标签及模型评测结果，保留测试证据和 unknown，不声称人工一致性已经验证。

接口与方法参考：[Codex 结构化评测](https://developers.openai.com/blog/eval-skills)、[模型判分建议](https://developers.openai.com/api/docs/guides/evaluation-best-practices)。
