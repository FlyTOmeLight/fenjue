# Hugging Face 公共 gold set 调查

调查日期：2026-10-13。本文核查官方数据集卡、Hub API、原始小样及作者仓库；没有发起模型推理调用。以下数据集均经 Hub API 确认为公开、无需申请访问。

调查后的实测结果见 [公开 gold 路由验证](public-goldens-validation.md)，包括原始通过数、分类开销及发现的数据语义问题。

建议先用 **CRUXEval 的输出预测**做小型客观验证，再补充 **HumanEval+ 的代码生成**。公开的参考输出或测试可以判断任务有没有做对；本次核查的数据中，没有能直接当作 Fenjue 当前 Sol/Astra 及 effort 选择真值的逐题结果。旧模型的胜负也不能直接换成当前模型的 low/medium/high 标签。

## 最适合开始的两套数据

| 数据集 | 实际 gold 与获取方式 | 适用范围与限制 |
| --- | --- | --- |
| [CRUXEval](https://huggingface.co/datasets/cruxeval-org/cruxeval) | MIT；800 道 Python 函数题；`test.jsonl` 约 187 KB，字段 `id, code, input, output`。输出来自实际执行。 | 首轮优先。输出预测给模型 `code + input`，只在验收时使用 `output`；输入预测则检查生成的输入是否产生目标输出，不能要求与参考输入相同。题目没有官方难度标签，不能将代码长度包装成难度金标。 |
| [HumanEval+](https://huggingface.co/datasets/evalplus/humanevalplus) | Apache-2.0；164 题；有直接下载的 `test.jsonl`，实读字段为 `task_id, prompt, canonical_solution, entry_point, test`。 | 用扩展测试验收代码生成，比只比参考实现字符串合理。首条 `test` 有 `numpy` 依赖，并非完全不需依赖。参考实现和测试应与模型输入隔离。 |

CRUXEval 是短程序理解基准，作者主动限制计算和内存需求，因此适合验证小任务是否被分配过高档位，但不能代表跨仓库修复。官方提供输入、输出两种任务及评估实现。HumanEval+ 通过增加测试提高验收覆盖；应使用官方测试语义，避免另写不等价的字符串比较器。[CRUXEval 作者仓库](https://github.com/facebookresearch/cruxeval)、[EvalPlus 作者仓库](https://github.com/evalplus/evalplus)。

## 后续补充的三套数据

| 数据集 | 实际 gold | 何时有价值 |
| --- | --- | --- |
| [BigCodeBench](https://huggingface.co/datasets/bigcode/bigcodebench) | Apache-2.0；1,140 个 Python 编程任务，包含 `complete_prompt, instruct_prompt, canonical_solution, test, entry_point, libs`；卡中推荐 `v0.1.4`。 | 需要检验多库调用、复杂说明和实用编程时引入。依赖安装和执行成本高于 CRUXEval；这是代码生成基准，不是完整代理仓库任务。 |
| [SWE-bench Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified) | 500 个经人工核验的仓库问题；包含 `problem_statement, base_commit, patch, test_patch, FAIL_TO_PASS, PASS_TO_PASS`，当前版本还包含 `image, eval_script` 等字段。 | 最贴近日常修 Bug，但需要仓库环境和官方测试运行流程。`difficulty` 是数据集字段，不能直接等同于模型 effort。Hub 卡未声明许可证，不能把评测代码的许可证自动套给问题、补丁及源仓库。 |
| [BFCL](https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard) | Apache-2.0；官方 HF 当前可见 V3 JSON 文件。实读多轮样本包含逐轮 `question`、`initial_config`、`path`、`involved_classes`。 | 验证连续任务、工具调用和缺信息场景。需要接上官方模拟工具、答案及状态验收器；只抽用户文本给 Jev 不能得到完整任务正确率。应固定版本，不能将 HF V3 称作最新 BFCL。 |

执行依据：[BigCodeBench 官方仓库](https://github.com/bigcode-project/bigcodebench)、[SWE-bench 数据与评测指南](https://www.swebench.com/SWE-bench/guides/datasets/)、[BFCL 官方评测代码](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard)。

## 为什么没有优先采用名字带 Router 的数据

- [RouterBench](https://huggingface.co/datasets/withmartian/routerbench) 包含三万多提示、11 个模型的响应、估计成本及表现分数；0-shot 和 5-shot 数据以 pickle 发布。可以研究离线路由指标，但这些是既有模型的结果，不是当前 Sol/Astra 的逐题测试。Hub 卡和文件列表未见数据许可证声明。[作者仓库](https://github.com/withmartian/routerbench)。
- [RouterEval](https://huggingface.co/datasets/linggm/RouterEval) 标为 MIT；官方仓库描述 12 个评测、8,500 多个模型及两亿多条记录，提供分数、提示、嵌入与打包的 router 数据。这里的 easy/hard 实验设置包含候选模型池规模，不能读作每道题的 effort 标签。本次未下载庞大的原始 ZIP，也未发现与当前候选完全一致的可用结果矩阵。[作者说明](https://github.com/MilkThink-Lab/RouterEval)。
- [RouteLLM 的 GPT-4 数据](https://huggingface.co/datasets/routellm/gpt4_dataset) 标为 Apache-2.0；实读 `valid.jsonl` 字段为 `prompt, source, gpt4_response, mixtral_response, mixtral_score`。它提供特定旧模型对的偏好监督，不是当前模型的客观执行 gold。官方文档也说明，更换评测模型对需要计算该模型对的结果。[RouteLLM 评测说明](https://github.com/lm-sys/RouteLLM#evaluation)。

[LiveCodeBench](https://huggingface.co/datasets/livecodebench/code_generation_lite) 有 `difficulty, contest_date, public_test_cases, private_test_cases`，适合后续按题目难度和时间分层。不过此次看到的 JSONL 文件至少百 MB 级，HF 卡的许可证为 `cc`，加载脚本却写 `MIT License`，应核清来源许可后再分发子集；不是第一轮最小验证的首选。[官方加载脚本](https://huggingface.co/datasets/livecodebench/code_generation_lite/blob/0fe84c3912ea0c4d4a78037083943e8f0c4dd505/code_generation_lite.py)。

## 最小实测设计

1. 固定 CRUXEval revision、采样种子和题目 ID，先取 12–24 题输出预测。样本在看到 Jev 或执行模型结果前确定。若需要生成任务覆盖，再单独增加少量 HumanEval+，不把两个集合混成一个有代表性的总准确率。
2. Jev 使用当前正式策略选档，执行模型只看到任务必需内容。所有候选使用相同提示、工具权限和上下文；CRUXEval 输出预测不允许直接运行题目，否则测到的是工具执行效果。参考答案只交给验收器。
3. 逐题运行所选档位和一个明确的相邻档位：高档题检查降档是否仍能通过，低档题检查升档是否能挽救失败。它们是反事实对照，不是固定 medium 的全量基线。只测两个候选时称为“已测候选中的更优选择”，不能称为全局最优档位。
4. 报告任务通过数、选档相对对照的独有失败数、双方都通过时的时间/token 差、路由自身耗时及 token；分别记录基础设施错误、格式错误与答案错误。时间包含 Jev 和执行，token 按输入/输出/缓存分开；没有价格依据时不换算成费用。
5. 若观察到有意义的档位差异，再对这些题重复执行并扩样。首轮小样本即使全部通过，也只能说明这些公开题未暴露选档问题，不能证明线上任务整体合理；多轮切换、架构判断和修复流程仍需 BFCL/SWE 或真实脱敏任务补充。

## 可复现版本

以下 SHA 由 2026-10-13 官方 `https://huggingface.co/api/datasets/<id>` 返回。实验必须在结果中同时保存实际内容摘要，避免只固定名称。

| 数据集 ID | Revision |
| --- | --- |
| `cruxeval-org/cruxeval` | `b96af0450242eb4da433032b90998f25588a5d0f` |
| `evalplus/humanevalplus` | `d32357cf319e50e9c8d8dab5ea876c72b0fd321b` |
| `evalplus/mbppplus` | `b2d74c91837c3f2a20c1299ae98133cbe7cfa077` |
| `bigcode/bigcodebench` | `b74c0d0bf70d2c0bc459be537895cca163007f1a` |
| `SWE-bench/SWE-bench_Verified` | `78f471bf655a3137b2e8a75af1501690ec009ec3` |
| `gorilla-llm/Berkeley-Function-Calling-Leaderboard` | `61fc0608cfd831fcfbbaa676ebdfef0ed963eeda` |
| `withmartian/routerbench` | `784021482c3f320c6619ed4b3bb3b41a21424fcb` |
| `linggm/RouterEval` | `0ee4de2661854b588474c211bebe97dc1e434237` |
| `routellm/gpt4_dataset` | `7ef62d690ff71ce9c21f4226cfc7bbc2ef9e6227` |
| `livecodebench/code_generation_lite` | `0fe84c3912ea0c4d4a78037083943e8f0c4dd505` |

CRUXEval 的固定下载地址：[test.jsonl](https://huggingface.co/datasets/cruxeval-org/cruxeval/resolve/b96af0450242eb4da433032b90998f25588a5d0f/test.jsonl)。HumanEval+ 的固定下载地址：[test.jsonl](https://huggingface.co/datasets/evalplus/humanevalplus/resolve/d32357cf319e50e9c8d8dab5ea876c72b0fd321b/test.jsonl)。MBPP+ 也是公开且标为 Apache-2.0，378 题，但本次核查的官方 HF 文件为 Parquet，因此没有优先于上述两个 JSONL 入口。[MBPP+ 数据卡](https://huggingface.co/datasets/evalplus/mbppplus)。
