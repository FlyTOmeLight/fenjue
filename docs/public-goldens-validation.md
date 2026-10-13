# 公开 gold 对当前路由的验证

2026-10-13。先保留当前 Jev 路由。这轮没有发现“当前选档失败、升档后成功”的题，但发现短任务的分类开销明显，以及公开 gold 本身的两处语义问题。结果不足以证明所有任务都应降为 low；下一轮应增加有完整环境验收的复杂任务。

## 数据与选档

从官方 Hugging Face 下载固定版本的 [CRUXEval](https://huggingface.co/datasets/cruxeval-org/cruxeval) 和 [HumanEval+](https://huggingface.co/datasets/evalplus/humanevalplus)，分别用标准输出和扩展测试验收。这两套数据没有针对当前 Sol/Astra 各 effort 的 gold 路由标签。其他候选与取舍见 [数据集调查](huggingface-goldensets.md)。

每套数据按 `SHA256("fenjue-public-goldens-v1:" + dataset + ":" + id)` 排序，前 24 题分类，其中前 6 题执行；在看到模型结果前固定。没有按代码长度猜测难度，也没有按测试结果挑题。

| 数据集 | 分类数 | 当前 Jev 选档 | 分类 P50 / P95 |
| --- | ---: | --- | --- |
| CRUXEval 输出预测 | 24 | 23 low、1 medium | 0.462 / 1.258 秒 |
| HumanEval+ 代码实现 | 24 | 24 medium | 0.510 / 0.965 秒 |

当前规则在这批数据上主要区分了“预测已有代码输出”和“实现函数”。所有题均选 Sol，没有触发 Astra。

执行样本：CRUXEval `sample_330, sample_360, sample_286, sample_12, sample_795, sample_211`；HumanEval+ `13, 132, 68, 67, 87, 141`。

## 正确率、耗时和 token

对每题运行所选档位，再加入 Sol low/high，相同档位只运行一次，共 31 个有效答案。没有固定 medium 的全量基线；medium 出现在当前路由实际选中它的题中。

下表保留原始 gold 分数。“当前路由”包含该题成功的 Jev 分类耗时和 token；low/high 是直接执行对照。时间为每题平均，token 为每题输入加输出的平均值。

| 数据集 | 方案 | 通过数 | 平均耗时 | 平均总 token |
| --- | --- | ---: | ---: | ---: |
| CRUXEval | 当前路由 | 6/6 | 8.02 秒 | 11,832 |
| CRUXEval | Sol low | 6/6 | 7.76 秒 | 8,541 |
| CRUXEval | Sol high | 6/6 | 10.10 秒 | 8,566 |
| HumanEval+ | 当前路由 | 4/6 | 13.99 秒 | 12,208 |
| HumanEval+ | Sol low | 4/6 | 12.87 秒 | 8,720 |
| HumanEval+ | Sol high | 4/6 | 11.20 秒 | 8,780 |

两组均未观察到升档挽救当前路由的独有失败。12 题合计，当前路由报告 144,238 token，直接 low 为 103,562，约多 39.3%。其中 Jev 分类占 40,324 token；执行部分相对直接 high 只少 159 token。对这些短单轮任务，分类开销超过了这次切档省下的执行 token。

token 由不同服务分别报告，这里比较数量，不换算价格或订阅额度。输入包含缓存命中，输出包含 reasoning，不重复相加。每个题目/档位只取得一次有效答案，缓存命中和服务排队也不同，因此时间表不是稳定的档位速度排名。线程创建与归档计入请求耗时，App Server 启动、验收器和人工续跑间隔未计入。

## 两道共同失败的诊断

原始分数仍为 HumanEval+ 4/6，没有事后删题或改 gold 提高分数。

- **HumanEval/132，题意有歧义。** 输入 `[][][]`，gold 为 `False`，low/medium/high 都返回 `True`。题面使用 `subsequence`，三个答案都实现了可跳过字符的 `[[]]` 子序列，而测试要求原序列中的嵌套。这里不能把失败直接归因于 medium 能力不足。
- **HumanEval/141，题面与 gold 冲突。** 输入 `éxample.exe`，gold 为 `Yes`，三档都返回 `No`。题面明确要求首字符在 `a-z/A-Z` 范围；参考实现使用 `isalpha()`，接受了带重音字母。三个生成答案都遵守了题面这一限制。

两道题都使用冻结下载文件中的原始测试计分。诊断是在已保存答案上定位首个失败输入，没有再次调用模型。参考实现能够通过自己的测试，并不保证题面和测试完全一致。

## 范围与执行记录

这是无工具的单轮能力诊断。分类复用当前五项问卷、真实 Jev 概率及 `balanced-native-v6` 规则；执行通过 Codex CLI 0.162.1 的 App Server，以新建临时线程提交实际选定的模型和 effort。模型只收到题目，不收到参考答案或隐藏测试。CRUXEval 要求 Python 字面量，使用 `ast.literal_eval` 后按 Python 值比较；这比官方允许表达式的输出协议更严格。HumanEval+ 使用固定 HF 版本的原始 `check(candidate)`，Python 3.14.8、NumPy 2.4.6。

累计 49 次分类尝试、35 次解题尝试，最终取得 48 个分类结果和 31 个有效答案。单独保留以下四次未计分解题尝试：评测入口误拒正常 `userMessage` 事件一次、未完整记录原因的远端失败一次、明确的 `serverOverloaded` 两次。另有 Jev `unavailable` 一次。恢复时复用已完成结果，没有更换题目或候选模型。

因此正确率表是**取得有效响应后的验收通过数**，不是首次请求的可用率。全部 84 次尝试中，80 次提供 token 计数，共观测到 436,927 token；其余 4 次用量未知，该值是已知下界。原始失败、各次用量、参考实现/错误答案预检、数据 revision 和 SHA256 均保留在 [结果文件](../evals/public-goldens/results-20261013.json)。

本轮没有覆盖 Astra、仓库级修改、长任务、多轮阶段切换或自动专家审查，也没有重演生产会话的全部执行流程。公开小题可能已进入模型训练材料，不能将本轮分数当作未见任务泛化准确率。下一步优先选择 SWE-bench Verified 的小型仓库任务，再用 BFCL 多轮任务检查阶段切换；通过真实验收比较所选档位与对照档位。

## 复跑

不需要将整套第三方数据或 Python 环境提交到仓库。数据来源分别标为 MIT 和 Apache-2.0，来源链接及固定版本见脚本 `SOURCES`。

```sh
mkdir -p .fenjue/public-goldens/cache
curl -fL 'https://huggingface.co/datasets/cruxeval-org/cruxeval/resolve/b96af0450242eb4da433032b90998f25588a5d0f/test.jsonl' \
  -o .fenjue/public-goldens/cache/cruxeval.jsonl
curl -fL 'https://huggingface.co/datasets/evalplus/humanevalplus/resolve/d32357cf319e50e9c8d8dab5ea876c72b0fd321b/test.jsonl' \
  -o .fenjue/public-goldens/cache/humanevalplus.jsonl
uv venv --python 3.14 .fenjue/public-goldens/venv
uv pip install --python .fenjue/public-goldens/venv/bin/python 'numpy==2.4.6'
npm run eval:public:goldens -- --config fenjue.config.json
```

默认只验证固定数据及官方参考答案/故意错误答案，不调用模型。当前代码执行验收器使用 macOS `sandbox-exec`；其他平台需要等价的隔离执行环境，本入口不会静默改成无沙箱执行。

真实调用需要明确上限：

```sh
FENJUE_CODEX_BIN=/opt/homebrew/bin/codex caffeinate -i npm run eval:public:goldens -- \
  --config fenjue.config.json --env-file /path/to/credentials.env \
  --live --max-classifier-calls 50 --max-model-calls 36 \
  --out .fenjue/public-goldens/new-run
```

失败后可用 `--resume-from .fenjue/public-goldens/previous-run` 写入新的 `--out` 目录继续。入口检查题目、gold 指纹、规则、阈值等保持一致，预算按包括此前失败在内的累计尝试数计算。调用次数限制不包含 Codex 内部可能发生的网络重试。

交付验证：只包含本次改动的独立快照中，197 项测试全部通过；12 题的参考答案通过且故意错误答案被拒绝。没有修改生产路由配置。
