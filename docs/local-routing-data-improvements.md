# 用日常数据精确改进路由：现有能力与最小下一步

本轮只读审核现有采集、反馈、分类标签与执行评测链路；没有调用模型或运行测试，也没有读取本地私人聊天正文。依据 2026-10-13 当前工作树。`native-session.ts`、`classifier-context.ts`、`task-evaluation.ts`、`scripts/evaluate-tasks.ts` 等存在其他进行中的修改；下面引用这些文件时描述当前实现，不宣称相关改动已发布或验证。其余引用文件未在本轮修改。

**最有价值的是把日常请求、人工验收和少量同任务对照关联起来，分清“理解错阶段”与“选错档位”。** 目前已经有采集、反馈、起始快照和独立验收，不需要先建设训练平台。收集更多文本本身不会让路由自动学会，反馈命令现在只记录人工判断，不更新生产规则。

## 目前能用什么，还缺什么

| 数据 | 已有能力 | 对路由优化的边界与补充 |
| --- | --- | --- |
| 请求与执行证据 | capture 保存用户输入、助手/工具证据，原生 taskId/turnId 可关联；恢复片段附 context | 图像等非文本会标不完整；重写历史/恢复需审核；不要用后续成功修复证据判断此前请求的复杂度。见 [native-records.ts:82](../src/native-records.ts#L82)、[cases.ts:28](../src/cases.ts#L28) |
| 路由决策 | planned/accepted 记录 reason、suggestion、classification（五项预测、概率和 inputTokens）、policy、held；accepted 才是已提交路线 | 概率是分类支持度，不是成功率；新任务边界有时分类两次，应单列调用；当前日志未保存独立、带 callId 的精确分类耗时与裁剪输入摘要。见 [native-session.ts:580](../src/native-session.ts#L580)、[native-policy.ts:52](../src/native-policy.ts#L52) |
| 人工切档 | 成功使用原生选档器后发 mode/native-model-picker；F8 控制发 mode/user-control，保存当前路线 | 可作为介入线索；未结构化记录“因慢/错/想省token/容量不足而切换”、原路线及哪一条决策触发。不能把每次手动升档当正确标签。见 [native-session.ts:101](../src/native-session.ts#L101)、[native-session.ts:368](../src/native-session.ts#L368) |
| 任务质量 | feedback 有 accepted/rework/blocked、reasoning/implementation/requirements/environment/unknown、reviewer、reason、evidence，可限定轮次 | 是人工声明，未自动执行验收；当前无独立的“路由不足/过强/合适”标签。completed 和沉默都不能当 accepted。见 [feedback.ts:9](../src/feedback.ts#L9)、[feedback.ts:114](../src/feedback.ts#L114)、[feedback.ts:139](../src/feedback.ts#L139) |
| 时间与token | 原生日志有 usage；周报关联任务、去重 token、统计 accepted→completed 时间，单列专家审查 | 周报不统计分类等待、输入/缓存/输出拆分；原始 classification 有输入token但周报不消费。跨窗口或缺失保持 null，不能拿未知当0。见 [feedback.ts:88](../src/feedback.ts#L88)、[feedback.ts:142](../src/feedback.ts#L142)、[continuous-iteration.md:59](continuous-iteration.md#L59) |
| 同任务执行对照 | 指定项目/路径保存首轮前代码快照；能登记独立验收、导出 calibration/holdout | 有基础设施后才能判断另一条路线是否更省、更好。模型只跑过实际选定路线时没有未选路线的结果；历史结果不能证明升档会修好。见 [execution-capture.ts:28](../src/execution-capture.ts#L28)、[execution-capture.ts:167](../src/execution-capture.ts#L167) |

当前工作树的执行实验已经统计 `classifierCalls/classifierTokens/classifierMs` 和各会话 usage；原生日常周报尚未达到同一粒度。可复用实验统计口径，而不重新设计格式。[evaluate-tasks.ts:169](../scripts/evaluate-tasks.ts#L169)、[evaluate-tasks.ts:198](../scripts/evaluate-tasks.ts#L198)、[evaluate-tasks.ts:295](../scripts/evaluate-tasks.ts#L295)

## 先把两个误差分开

1. **分类误差：** 人工按当时可见请求、目标与证据标注五项 features，和 Jev 比较。优先抓“诊断→原因已知后的实施”“实施→机械交付总结”“新独立任务”“含糊指代”这些用户实际频繁发生的阶段转换。它们决定是否能减少切档；答案长短不能代替阶段。
2. **策略误差：** features 正确，选出的路线仍可能过强或不够。挑少量可回放任务，从相同起始快照对照当前规则与一个候选规则，用独立验收、总耗时及完整token比较；不再引入用户已明确拒绝的固定 medium 主基线。

已有 `cases draft` 会把标签置 null 并要求独立审核，不让分类器自行填写。**native 格式导出时 allowed 路由由现有策略从已审核 features 推导，是 declared-policy。** 这能检查是否按规则路由，却不能证明该模型是质量所必需，不能拿导出路由作“最优档位”金标。[cases.ts:48](../src/cases.ts#L48)、[cases.ts:78](../src/cases.ts#L78)

Judge 可以辅助生成分类/质量参考，导出会明确记录 reviewKind=model。它没有把模型参考变成人工标签，也不更新反馈或配置；用于人工 gold 的部分仍需真实审核。当前 Judge 的 expected 参考还按旧三档工作类型定义，因此其一致率也不能独立验证生产模型需求。[judge.ts:67](../src/judge.ts#L67)、[cases.ts:64](../src/cases.ts#L64)、[cli.ts:60](../src/cli.ts#L60)

## 用现有工具先跑通一个小周期

- **日常留样：** 保持真实使用。按明确项目路径采集，留下普通成功任务，同时留下返工、手动切档、低置信度和阶段转换任务。使用现有 feedback list/add/report；仅需给选中的任务补具体原因和验收证据，不要求每轮手标全部分类。
- **每周审核约 10–20 个完整案例：** 先不展示预测，审核当时的五项标签；再揭示 Jev 和所选路线。固定比例选普通成功/无反馈样本，不能只挑失败；unknown 结果单列。原因分别归为分类、策略、实施、需求或环境，容量错误不算复杂度误判。已有周报保留普通任务，但候选按失败排序，直接取列表前 N 条会偏向失败。[feedback.ts:149](../src/feedback.ts#L149)、[continuous-iteration.md:63](continuous-iteration.md#L63)
- **一次只改一个可解释规则：** 本轮应优先验证多步检索与复杂实施的推理需求；诊断完成后转为实施的降档规则已存在，应检查实际阶段识别是否正确。先用审核数据测标签是否改善，再挑对应的可回放任务比较质量和开销。究竟改哪条，应由本轮公开集及本地样本的实际结果决定，不能预设结论。
- **候选冻结后再看新任务：** 同会话不能横跨开发与验证；更可靠的是按新项目/未来时间窗口留一组任务。已有执行 suite 阻止同 project group 跨 calibration/holdout；同一项目的任务不能随机拆成独立的两组。事后补验收只能 calibration，首版多轮日常回放也只能 calibration。新冻结执行验证使用预登记单条任务。公开集不能替代用户日常分布。[task-evaluation.ts:56](../src/task-evaluation.ts#L56)、[execution-capture.ts:174](../src/execution-capture.ts#L174)、[execution-capture.ts:185](../src/execution-capture.ts#L185)

多轮里用户说“还有问题”“改成这个方案”，往往取决于上一条实际回答。把这些输入按原顺序发送给另一条路线，并不保证它也产生了原来的前提；目前代码把多轮 holdout 拒绝导出是有依据的。第一步用这种数据审核阶段识别，执行质量验证另选预登记任务，不伪称等价的多轮反事实。

所有未来评测应先展示抽样内容、标签来源、要验证的单一假设及预算，等待用户确认后执行。这是用户在本会话提出的要求。

## 真正需要补代码时，只补三个点

1. **决策成本记录：** 为每次分类记录 callId、所属 decisionId、耗时、成功/失败、输入token及问卷/上下文策略摘要；区分第一次边界判断和第二次新任务判断。通过 decisionId 关联 submitted turn，避免仅按时间把取消/拒绝/新任务的分类错配到旧任务。保存脱敏裁剪输入或足够重建它的版本信息，可复查“完整历史中有证据，裁剪后没看到”的错误。classifying→planned 还包含恢复历史与快照准备，只能代表整体路由准备时间，不能冒充纯分类时间。[native-session.ts:203](../src/native-session.ts#L203)、[native-session.ts:75](../src/native-session.ts#L75)、[classifier-context.ts:34](../src/classifier-context.ts#L34)
2. **低负担介入反馈：** 现有 feedback 接收一个可选的路由评价与介入原因，关联具体 turn；优先在用户确实切档或返工时补。合适/过强/不足是人工看法，不立即改规则。环境失败与服务容量问题保留不同字段，防止把“换模型才等到可用容量”学成“复杂任务必须升档”。
3. **周报按阶段比较：** 展示五项偏差及 reasoning 转换、人工介入、独立验收、分类等待、执行与专家token；对已批准候选做配对统计。失败、缺失及未知分别保留，输入缓存是input的子集，reasoning是output的子集，不能重复加。先不微调模型，不上线按单个成功/失败即时学习。

## 本地保留与共享

`.fenjue/` 在 gitignore；文本有已知凭据/常见凭据格式脱敏，文件权限一般为 0600、目录 0700。但自然语言中的任意敏感信息不能保证被识别；代码快照为可回放保留原始字节。只公布统计和最小合成例子，日常素材留本地。省略 capture 也仍会留下用于恢复的状态/日志，不能误认为完全没存任务文本。[capture.ts:13](../src/capture.ts#L13)、[native-records.ts:33](../src/native-records.ts#L33)、[task-evaluation.md:109](task-evaluation.md#L109)、[daily-use.md:125](daily-use.md#L125)、[.gitignore:3](../.gitignore#L3)

审核的链路没有自动保留期限；执行模块的 discard 清理的是未接受的快照，不是按年龄清理历史。阶段性留存应作为用户可选择的本地操作，保留仍在使用的状态及被冻结的数据集，不把“删完训练数据”写成默认后台行为。
