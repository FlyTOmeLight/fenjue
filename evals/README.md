# 可公开的评测用例

本目录发布小规模合成分类和完整执行用例，不分发真实聊天记录、个人项目快照或远程模型原始运行日志。

| 路径 | 内容 |
| --- | --- |
| `chinese-tasks.json` / `chinese-validation.json` | 三档分类的合成开发与验证用例 |
| `native-routing/calibration.json` | 新写的合成阶段变化用例 |
| `native-routing/holdout.json` | 与校准组分离的合成原生路由用例 |
| `execution-pilot/` | 六个合成完整任务、诊断组合与验收器 |
| `native-routing/execution/` | 分页和事件账本两个合成完整任务 |

标签由用例作者声明，用于检查策略符合预期；不是独立人工标注的真实任务 golden set。已经用于开发的 holdout 不应再次当作新的独立验证集。

```bash
npm run eval:classifier
npm run eval:native:classifier -- --config examples/native-balanced.json
npm run eval:tasks -- --dry-run
```

默认不调用远程模型。真实评测需显式启用 `--live` 并提供运行预算。详见 [完整任务评测](../docs/task-evaluation.md) 和 [模型判分](../docs/model-judge.md)。

历史第三方 WorkflowEvals 环境和实验产物留在维护者本地，不是项目依赖，也不进入发布仓库。历史质量对照的公开摘要见 [结果说明](../docs/evaluation-results.md)。
