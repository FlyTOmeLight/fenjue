# 人工难度与 Fenjue 路由：2026-10-13

**当前路由对人工难度有部分区分，但工作类型覆盖了内部难度：代码修复集中在 medium，多步助理任务集中在 low。优先补充推理需求的表达，再用本地验收决定怎么选档。** 本轮保留 Jev 与 `balanced-native-v6`，没有修改生产问卷、路由规则或配置。

用户先审核并批准 SWE-bench Verified 与 GAIA，随后完成 GAIA 访问及官方 CLI 登录，并明确授权把抽样题目发送到当前 Jev/Vercel 服务。只公布本文与 [汇总 JSON](../evals/human-difficulty/summary.json)；GAIA 题目、答案、标注记录及逐题结果不发布。

## 怎么跑的

- SWE-bench Verified：固定官方版本 `78f471bf655a3137b2e8a75af1501690ec009ec3`，500 题。人工标签估计熟悉代码库的工程师完成修复的时间，属于预计工时，不是实测。四档原有 194、261、42、3 题；各取至多 20 题，得到 63 题。最难档的 3 题全部纳入。[官方数据](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)、[人工标注方法](https://openai.com/index/introducing-swe-bench-verified/)
- GAIA：固定官方版本 `682dd723ee1e1697e00360edccf2366dc8418dd9`，当前 validation 165 题。只纳入无本地附件的 127 题，三个等级有 42、66、19 题；取 20、20、19 题。排除 38 道带附件题；无本地附件仍可能要求网页、视频或外部工具，本轮只评估读到请求时的路由。等级描述行动步骤及工具组合，不是 Codex effort 金标。[官方数据与共享条件](https://huggingface.co/datasets/gaia-benchmark/GAIA)、[等级及人工流程](https://arxiv.org/html/2311.12983v1)
- 每档按 `SHA256("fenjue-human-v1:" + dataset + ":" + id)` 排序抽样，抽样在模型调用前完成。每题重复两轮，没有挑结果好的样本或追加重试。
- SWE 只发送仓库名、修复请求及 `problem_statement`，不发送 hints、补丁、测试或 difficulty；GAIA 只发送原 Question，不发送 Level、Final answer 或 Annotator Metadata。请求中的原始文本不删改。
- 同一 `typesafe-ai/jev`、0.75 阈值、24,000 字节预算、30 秒超时。直接调用现有 `createClassifier` 与 `nativeSelection`；空历史，无 previous route。问卷、输入及数据文件摘要见汇总文件。专家模型配置为 `gpt-6-astra`，主模型为 `gpt-6.1-sol`。
- 本轮检查单轮请求的分类和档位关联。没有执行解题，没有启动完整网关、后续阶段识别、容量切换或专家审查，也没有运行用户已排除的固定 medium 执行基线。

路由源码基于 `f1988dd6fc10bbf96a29bfa67fc254ae188270a3`；本轮使用的以下文件未改动，SHA256 为：

```text
src/classification.ts  818d5e7a77cb62f836d5d638c890f8709dd0b66b378a27b24aba57c594b30141
src/native-policy.ts   38e4c65b6e1b1472f4758ecd829828eccc36270ea9aaab6f1edbca44c2ca50b8
src/task-state.ts      29920e44fd0ccd047fdfb0ac14351c4d078d187fe9d107ab1a2a6ad714ef32f9
```

## 路由结果

下表是两轮的分类次数，同一题的重复不能当作两个独立样本。全部有效结果均选择主模型；该结果不能证明专家模型无用。

| 数据集 / 人工等级 | 原始题数 | low | medium | high | 未取得有效分类 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SWE <15 min | 20 | 0 | 36 | 4 | 0 |
| SWE 15 min–1 hour | 20 | 0 | 28 | 10 | 2 |
| SWE 1–4 hours | 20 | 0 | 27 | 13 | 0 |
| SWE >4 hours | 3 | 0 | 6 | 0 | 0 |
| GAIA Level 1 | 20 | 38 | 2 | 0 | 0 |
| GAIA Level 2 | 20 | 35 | 4 | 0 | 1 |
| GAIA Level 3 | 19 | 32 | 6 | 0 | 0 |

SWE 前三档的 high 比例从 10% 到 26.3%、32.5%，存在方向一致的差异；最难档全 medium，但只有 3 题，不能据此估计全部困难代码任务的表现。GAIA 最难档 84.2% 仍是 low。

在每轮内比较不同人工等级的有效题目，数更难题是否获得更高 effort；同档位单独记录：

| 数据集 | 难题选更高档 | 难题选更低档 | 两题选相同档 |
| --- | ---: | ---: | ---: |
| SWE | 596 / 2674（22.3%） | 326 / 2674（12.2%） | 1752 / 2674（65.5%） |
| GAIA | 295 / 2281（12.9%） | 131 / 2281（5.7%） | 1855 / 2281（81.3%） |

这是描述性排序统计；配对共享题目、两轮共享输入，不能把配对数当独立样本做显著性检验。工时及工具步骤不直接等于模型需要的推理强度，因此这些数字不是“路由准确率”，也不能证明某道题必须升档。当前表达难度的能力仍有明确缺口。

## 稳定性、耗时和 token

| 指标 | SWE | GAIA |
| --- | ---: | ---: |
| 实际 HTTP 请求 | 124 | 118 |
| 有效分类 | 124 | 117 |
| 两轮均有效的题数 | 62 | 58 |
| 两轮路线变化 | 1 / 62 | 0 / 58 |
| 两轮五项标签变化 | 2 / 62 | 2 / 58 |
| 单次耗时 p50 / p95 | 492 / 907 ms | 434 / 997 ms |
| 输入 / 输出 token 总量 | 432112 / 27276 | 359910 / 26260 |
| 平均每次 HTTP 请求 token | 3705 | 3273 |

共 242 次 HTTP 请求，845558 token，分类调用累计约 134.6 秒；这不是任务完成耗时。耗时包括客户端请求、解析和选择，不包括文件落盘。供应商未提供 cached/reasoning 子项，保持未知，不补零或重复相加。未核验模型单价，不报告货币费用。

SWE 的同一道长题两轮均 `input-budget`，在 HTTP 前拒绝；题目约 22.8KB，加问卷及 JSON 后超过 24KB。本轮没有截掉关键请求绕过预算。完整网关遇到此类失败会另有保留/默认路线行为，本轮结果只记录错误，不伪造一次成功分类。GAIA 有 1 次 `invalid-response`，供应商 usage 已返回，因此计入耗时和 token；另一轮有效，未重试替换失败记录。

唯一发生路线变化的 SWE 题，五项标签完全一致，high 支持度从 0.67 到 0.75，跨过阈值后从 medium 到 high。这说明标签稳定仍可能出现边界切档；没有观察到需要全面改动稳定策略的证据。

## 自动路由先改哪里

### 1. 区分工作类型与内部推理需求

[当前 reasoning 问题](../src/classification.ts)问的是“做什么”：机械操作、实施、诊断、架构。它没有直接问“完成这件事需要多深的推理”。SWE 的 124 次有效分类有 123 次是 solution，最难 3 题均为 solution+sufficient+contract。已知规则、信息充分，并不代表算法或实现简单。

GAIA 的 117 次有效分类中 109 次是 mechanical；包括 Level 3 的 34 / 38 次。现有定义把“查询现有状态或工具”放进 mechanical，随后 [选档规则](../src/native-policy.ts)对高置信 mechanical+reversible 倾向 low。检索题需要多次定位、交叉验证或计算时，现有类别仍可能把它和一次直接查询放在一起。

**建议优先做一个候选问卷：保留工作类型，补充推理需求，明确简单查取与多步检索/验证、局部常规实施与含依赖/分支约束的求解。** 先让候选只记录建议、不改变实际路线，并由人盲标抽样请求；再对可回放的本地任务比较验收、总耗时和 token。不能把 GAIA Level 或预计工时自动变成新标签，不能预设全部复杂查询都要 high。

### 2. 用实际效果校准 unknown_cause、sensitive 和专家选择

SWE 的 27 次 high 中，23 次由 unknown_cause 达到阈值、4 次由 sensitive 达到阈值，没有一次由 diagnosis 单项达到阈值。high 更容易识别未知根因或操作后果，难度相同的日常实施仍缺少区分。

下一步应抽查：简单故障是否因“根因未知”过早升档，信息齐全的复杂实施是否长期停在 medium；分别拿独立验收和用量验证。涉及敏感操作的质量要求保留，不能仅凭人工工时取消现有选档规则。`cross_system` 目前决定专家倾向，但系统个数也不能代表专家模型的实际收益；本轮样本没有触发专家，无法校准该条件。

不要通过统一降低阈值解决这些表达缺口：它不能给同样的 solution/sufficient 或 mechanical/reversible 题提供新的难度信息，也会影响其他切档。

### 3. 同时核算分类本身的成本和输入预算

分类延迟当前不到一秒的中位数，但每次约 3.3k–3.7k token。五个问题都重复长公共说明，成本中有稳定的问卷开销。可以单独测试减少重复说明后的标签与路线稳定性，验证后再采用；本轮没有测过精简版本，不承诺节省比例。

长请求的预算失败已经出现。后续应把“拒绝分类的比例、当时实际选了哪条路线、是否返工”纳入周报；不能用静默截断输入掩盖复杂请求。现有历史裁剪针对旧上下文，不能解决这道首次请求的问题。

## 本地日常数据怎么用得更准

详细链路审核见 [本地数据改进建议](local-routing-data-improvements.md)。建议按以下顺序推进：

1. **先关联完整决策。** 每次分类记录独立 callId、实际裁剪输入/版本、耗时和完整 usage，并关联 planned→accepted 路线。新任务可能分类两次，专家审查也花 token；总耗时从用户发出请求开始计，不能只看 accepted→completed。
2. **让反馈说明切档原因。** 现有 feedback 已能记录 accepted/rework/blocked 和证据；补充慢、质量不足、想省 token、容量问题及原/新路线。人手动升档只是线索，不能自动成为正确答案；completed、沉默也不是验收通过。
3. **每周盲审 10–20 个完整案例。** 包括普通成功/无反馈、手动介入、失败和阶段转换。先隐藏 Jev 预测、标注当时可见输入的工作类型和推理需求，再查路由。分类理解错与选档规则错分开处理；不要用后续修复结果给此前请求补标签。
4. **拿少量相同起点做执行对照。** 复用已有代码快照、预登记验收和 tasks 导出，对当前策略与一个候选策略比较质量、总耗时、token、手动干预。只看实际运行过的路线无法知道另一档能否更好。当前 `cases export` 从人工 features 推导的 allowed route 是现有规则的声明，不能当“最优档位”金标。
5. **候选冻结后，用未来任务验证。** 同项目/同会话不随机拆到开发和验证两组；先看新时间窗口或新项目。已经分析过的本轮公开题是校准材料，不能重复拿它宣布新候选的独立验证成绩。

本轮建议从推理需求的候选标签和决策成本关联开始，保留 Jev。是否升档由本地对照里的质量收益和时间/token成本共同决定；现在的数据不足以训练“最佳路线”预测器，不需要先做微调或自动在线学习。

## 复现与验证

准备脚本需要 PyArrow；本次本地环境为 Python 3.14.8、PyArrow 24.0.0，CLI 为 huggingface_hub 2.2.0。依赖仅安装到 `.fenjue/public-goldens/venv`，没有新增生产依赖。CLI 授权保存在 `.fenjue/human-difficulty/hf-home`，不是 shell 全局登录。

```sh
# 先按官方 CLI 完成登录；GAIA 需要账户已获准访问
HF_HOME="$PWD/.fenjue/human-difficulty/hf-home" .fenjue/public-goldens/venv/bin/hf download gaia-benchmark/GAIA 2023/validation/metadata.parquet --repo-type dataset --revision 682dd723ee1e1697e00360edccf2366dc8418dd9 --local-dir .fenjue/human-difficulty/cache/gaia

.fenjue/public-goldens/venv/bin/python scripts/prepare-human-difficulty.py --swe .fenjue/human-difficulty/cache/swe-verified.parquet --out .fenjue/human-difficulty/swe-input.json
.fenjue/public-goldens/venv/bin/python scripts/prepare-human-difficulty.py --gaia .fenjue/human-difficulty/cache/gaia/2023/validation/metadata.parquet --out .fenjue/human-difficulty/gaia-input.json
npm run build
# 不加 --live 时只预检，不发模型请求；报告路径须不存在
node dist/scripts/evaluate-human-difficulty.js --input .fenjue/human-difficulty/swe-input.json --out .fenjue/human-difficulty/preflight.json --repeats 2
# 获得向当前分类服务发送题目的授权后，另用报告路径运行：
# SWE 加 --live --max-calls 126 --env-file /Users/light/.env.local
# GAIA 替换为 gaia-input.json，另用报告路径，加 --live --max-calls 118 --env-file /Users/light/.env.local
python3 scripts/summarize-human-difficulty.py .fenjue/human-difficulty/swe-results.json .fenjue/human-difficulty/gaia-results.json --out evals/human-difficulty/summary.json
```

本次按数据集分开运行，合并摘要，不共用同一个输出文件。完整材料保留在本地 `.fenjue/human-difficulty/`。普通沙箱下全量测试因禁止本地 socket 监听失败；在允许监听的干净 HEAD 临时副本加入本次脚本与测试后，199 / 199 测试通过。类型检查、新增隔离输入/汇总隐私与排序测试、Python 语法及真实准备/汇总运行通过。
