# 人工任务难度标签来源与选型记录

初次查阅日期：2026-10-13。以下保留选型时的调查记录。用户随后批准 SWE-bench Verified 与 GAIA；实际抽样、分类结果和限制见 [人工难度路由评测](human-difficulty-routing-evaluation.md)。其他候选未运行。

**针对 Fenjue 的代码工作，优先推荐 SWE-bench Verified；针对通用助理任务，推荐 GAIA 作补充。** BLUR 提供由人类实际查找耗时划分的难度，适合进一步核对模糊请求的检索推理需求。ComplexBench 的人工标签描述中文指令约束结构，但没有整体难度等级。

这些数据都没有人工标注的“该选 Codex low / medium / high / Astra”答案。应先确认希望验证任务难度排序，还是 Fenjue 的五项分类；后者仍需按项目规则补充人工标签。

## 1. SWE-bench Verified：最接近实际代码修复

- **来源与规模：** [官方 HF 数据集](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)，500 个真实 GitHub issue 与对应修复实例。
- **人工来源：** 93 名有 Python 经验的软件开发者参与；每条由三个不同标注者评审。难度估计对象是已经熟悉代码库的有经验工程师决定并实施修复所需时间，四档为 `<15 min fix`、`15 min - 1 hour`、`1-4 hours`、`>4 hours`。难度取多数票，无多数时取中位数；不是实际计时。官方没有在该说明中单独报告难度标注一致性系数。[标注说明与合并方法](https://openai.com/index/introducing-swe-bench-verified/)
- **字段与公开样例：** HF viewer 明确有 `instance_id`、`repo`、`base_commit`、`problem_statement`、`hints_text`、`difficulty`，同时也有 `patch`、`test_patch`。例如 `astropy__astropy-12907` 的 `difficulty` 是 `15 min - 1 hour`，任务是嵌套复合模型的可分离性矩阵计算错误。该样例来自数据卡展示，未执行修复。[字段与实例](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)
- **适用与缺口：** 可检查 Jev 是否把工程师认为难的修复系统性判得更简单；`reasoning` 与 `uncertainty` 有场景关联。但预计工时也包含定位、阅读和实现量，不能直接等同推理强度；文件数也不能从 `difficulty` 推出。没有 `relation`、`scope`、`consequence` 的人工金标。单次 issue 不覆盖多轮阶段转换。
- **获取：** 当前官方 viewer 可公开读取；本次未登录、未下载完整语料。该 HF 页面未展示明确的数据许可证标识；[SWE-bench 仓库](https://github.com/SWE-bench/SWE-bench)的 MIT 标识不能自动替代来源代码库各自的授权。
- **审核时应看：** 同时展示四档 issue，并隐藏 `difficulty`、修复补丁、测试补丁和 PR 答案，避免把评测答案喂给分类器。上述隐藏是后续方案，尚未执行。

## 2. GAIA：有人工定义的通用助理任务等级

- **来源与规模：** [官方 HF 数据集](https://huggingface.co/datasets/gaia-benchmark/GAIA)，论文报告 466 题；包含网络查询、文件阅读、计算和多种工具协作。
- **标签定义：** `Level` 为 1–3，依据解题所需步骤和工具能力：Level 1 通常至多一种工具、少量步骤；Level 2 通常约 5–10 步且组合工具；Level 3 允许较长行动序列和任意工具组合。这些是宽松标准，论文明确说明复杂网页导航可使少于十步的题进入 Level 3。[论文 §3 与 Appendix C](https://arxiv.org/html/2311.12983v1)
- **人工来源：** 人工构题时记录等级、解题步骤、工具、时间和答案；两名新的独立标注者再答题，检查答案是否一致并修复/移除有问题的题。该复核验证的是答案，不应宣传成“三人对难度等级独立投票”；论文未给等级标注的单独一致性指标。[人工流程](https://arxiv.org/html/2311.12983v1)
- **字段与公开样例：** 官方数据卡列出 `task_id`、`Question`、`Level`、`Final answer`、`file_name`、`file_path`、`Annotator Metadata`。论文公开展示的 Level 1 样例要求查 NIH 一项临床试验的实际招募人数；标注记录使用浏览器、8 分钟。这也说明等级标准不是机械的步数阈值。[当前字段](https://huggingface.co/datasets/gaia-benchmark/GAIA/blob/main/README.md)、[论文示例 Table 1](https://arxiv.org/html/2311.12983v1)
- **适用与缺口：** 适合验证研究/检索任务的操作复杂度排序；工具个数不能映射 Fenjue 的 `scope`，因为 `cross_system` 指系统间协议和架构协作，不是访问多个网站。需要查网页也不等于 `uncertainty=missing`。没有五项分类的直接金标，也没有阶段转换标签。
- **获取与授权：** HF 需登录、接受条件并分享联系信息；数据卡要求不要在可爬取格式中转发 validation/test 语料。本次只看公开卡片与论文，未接受条款或获取受控内容。论文公开示例可用于让用户理解任务类型；后续完整抽样应在获准访问后私下审阅。[官方访问条件](https://huggingface.co/datasets/gaia-benchmark/GAIA)

## 3. BLUR：人类实测耗时的检索推理难度

- **来源：** [PatronusAI 官方 HF 数据集](https://huggingface.co/datasets/PatronusAI/BLUR)。完整研究语料 573 题，公开发布 350 题，其中 250 题不公开答案；题目根据碎片记忆寻找特定对象，部分含附件。
- **人工来源与标签：** 一人编写回忆描述并查到答案，另一人独立查找并记录步骤。答案一致或经事后复核承认错误后纳入。`difficulty` 按验证者实际耗时分档：easy <10 分钟、medium 10–20 分钟、hard >20 分钟。这是**人类行为测量形成的派生难度标签**，不是人工主观评分，也不是模型生成标签；数据卡没有报告难度等级多人一致性。
- **字段与公开示例：** `query`、`file`、`scaffolded_query`、`answer`（仅 validation 有答案）、`domain`、`difficulty`。公开卡片举例：用户记得某本 2017 年的书，其封面、主题和作者另一部书的线索，要求找到书名。**卡片没有展示这个样例的 difficulty，不能擅自补等级。**
- **适用与缺口：** 可检验模糊描述、多个线索综合的任务是否获得较强路由，但耗时同时受搜索熟悉度和外部信息可见性影响；输入模糊不一定是 Fenjue 的 `missing`，若可通过搜索确定就可能仍充分。未提供五项分类及多轮阶段金标。
- **获取：** MIT；HF 当前要求登录并接受访问条件、分享联系信息。本次只读取公开卡片，未进入受控语料。[上述来源、字段、示例与阈值均见官方卡片](https://huggingface.co/datasets/PatronusAI/BLUR)

## 4. ComplexBench：人工标注的约束结构，中文补充

- **定位：** 不是整体难度等级金标。论文发布 1,150 条复杂指令，标注约束维度、任务类型、组合方式与评分问题；4 类约束、19 个维度、4 种基本组合方式及嵌套结构。[论文](https://arxiv.org/html/2407.03978v2)
- **人工来源：** 12 名大学生受训后构造并标注指令，其他标注者交叉检查。GPT-4 在参考指令分配阶段辅助获取约束维度，因此不能说整个流程完全无模型；最终指令及结构由人工构造、标注并校验。论文报告的自动评分与人类评分一致性，属于输出评分器评估，不是复杂度标签一致性。[正式论文 Appendix F](https://proceedings.neurips.cc/paper_files/paper/2024/file/f8c24b08b96a08ec7a7a975feea7777e-Paper-Datasets_and_Benchmarks_Track.pdf)
- **字段与公开样例：** `instruction`、`instruction_en`、`task_types`、`constraint_dimensions`、`composition_types`、`category`、`scoring_questions`（含 `dep` 依赖）。官方 `main_id=899` 要先判断两个案例的特别提款权，再按判断结果选择写申请文或解释，并满足不同长度/分点要求；标签包含 `And` 与 `Selection`。[官方 schema 与示例](https://github.com/thu-coai/ComplexBench)
- **适用与缺口：** 可审核 Jev 是否把多重条件、分支和依赖任务误判为简单文本转换。但约束很多、嵌套很深也不自动等于 `architecture` 或耦合方案权衡；不能用嵌套深度直接建立 low/high 金标。缺少五项分类、整体难度和多轮关系的现成金标。
- **获取：** 确认的作者发布入口是 [GitHub](https://github.com/thu-coai/ComplexBench)，`data/data_final.json`；原版中文，后加英文。仓库标示 MIT。**本次没有核实到作者官方 HF 数据仓库，不把其他转载冒充官方 HF 候选。** 如果用户坚持全部来自 HF，此项只保留作参考。

## 其他候选：MATH 限数学专项，不作主集

- **来源：** [作者仓库](https://github.com/hendrycks/math)目前直接链接 [HF `qwedsacf/competition_math`](https://huggingface.co/datasets/qwedsacf/competition_math)，因此该镜像有作者入口背书。
- **标签来源：** 论文的 12,500 道竞赛题有 Level 1–5，沿用 AoPS 的人类难度分层，在各学科内从易到难。论文没有报告统一新标注流程的标注者人数、逐题投票数或一致性，不应把它说成严格的三人复核复杂度标注。[论文 §3.1](https://arxiv.org/pdf/2103.03874)
- **字段与样例：** `problem`、`level`、`type`、`solution`。HF viewer 的 Level 1 Algebra 样例是给定 x=2、y=5 代入表达式；另有多项式次数判断标为 Level 3。当前镜像将 12,500 题放在单一 train split，viewer 显示 level 有六种取值，正式使用前需要检查额外取值，不能假定全部只有 Level 1–5。[实际 viewer](https://huggingface.co/datasets/qwedsacf/competition_math)
- **适用与缺口：** 可测数学题的难度排序，但数学难度不能直接对应 Fenjue 的工程工作类型；难数学题也可能全部是局部求解、信息充分、可逆操作，五项分类相同。若目前策略不能表示局部算法内部难度，单靠提高分类正确率不会补上这一能力。
- **获取：** HF 公开可读、页面标示 MIT；本轮未下载/运行。

## 不采用 HelpSteer 的 complexity 作任务金标

[HelpSteer](https://huggingface.co/datasets/nvidia/HelpSteer)的 37,120 条数据包含 prompt 与模型生成的 response。约 200 名 Scale AI 美国标注者对回答做 0–4 评分，`complexity` 的对象是**写出这条回答所需的智力/专业深度**。同一 prompt 的不同回答可获不同分数。因此它确有人类 complexity 标注，但不是请求本身的复杂度，不能直接作为 Jev 对 prompt 判断的金标。页面标示 CC-BY-4.0。

## 两个看起来匹配、但尚不能作人工 gold 的来源

- **FLASK：** 论文先在 200 条上比较人工与 Eval LM 的元数据标注，再用 Eval LM 标注全量技能、领域和难度。全量 `difficulty` 不能称为纯人工标签；如后续能找到公开的原始人工子集，可另行审核。[论文 §3.2](https://openreview.net/pdf?id=5dI6ZphLYX)、[官方标注实现](https://github.com/kaistAI/FLASK/tree/main/metadata_annotation)。
- **NVIDIA Prompt Task and Complexity Classifier：** 官方模型卡说明训练用了 4,024 条人工标注的英文提示，维度包括推理、约束、领域知识等，方向很贴近需求。但本次检查官方文件列表，只找到模型权重、配置、tokenizer 等，未找到原始人工标签的下载入口。模型预测结果不能替代人工 gold；`agentlans/alpaca-prompts-annotated` 明确由该模型自动标注，也不属于人工标签。[模型卡](https://huggingface.co/nvidia/prompt-task-and-complexity-classifier)、[文件列表](https://huggingface.co/nvidia/prompt-task-and-complexity-classifier/tree/main)、[自动标注数据卡](https://huggingface.co/datasets/agentlans/alpaca-prompts-annotated)。

## 小型专业领域补充：专家难度评分及理由

[HumanEdgeAI/Corp_Taxes](https://huggingface.co/datasets/HumanEdgeAI/Corp_Taxes)公开税务专家对任务的 `Difficulty` 和 `Difficulty Reasoning`，包含独立评审者的评分与解释，保留分歧，标为 CC-BY-4.0。这符合“人工对任务难度打分”，但只适合专业推理样例审阅，不宜作为通用路由主集。

本次读取的 HF viewer 显示 11 行及多轮历史评审字段，卡片正文却描述 7 个最终任务与两组最终评审，二者不一致。未下载原始文件核对，因此不报告一个确定的当前样本量，也不把历史字段误当作最终 gold。同一题出现 `Moderate` 与 `Hard` 等不同意见，不能在未经约定的情况下自行合并为单一标签。

## 提交用户审核的下一步（尚未运行）

建议先选 SWE-bench Verified 作为开发任务主集，GAIA 作为通用助理补充；ComplexBench 仅在接受非 HF 官方来源时增加中文结构样例。先展示标签定义及跨档样本，再由用户确认数据集和指标后实施抽样。

原生标签只能支持难度分层与路由强度的关联检查。若需要五项分类准确率，应由人工按 [当前问卷](../src/classification.ts)标注抽样请求，并保留争议；不能把预计工时或 Level 1–3 自动转换成 Fenjue 五项分类，或 low / medium / high 的标准答案。未来的任务成功率实验则是另一个问题，需要另外确认执行方案。
