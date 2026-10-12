# 原生路由合成评测

`calibration.json` 是公开整理时新写的合成命令行工具场景，覆盖方案比较、已定参数整理和独立实施请求。此前的真实会话校准材料留在本地，不公开。

`holdout.json` 包含调度器、已知协议、局部故障与依赖取舍四个合成场景。它与校准集按 group 分离，但已用于开发，不能据此声称新的独立验证准确率。

```bash
npm run eval:native:classifier -- --config examples/native-balanced.json
npm run eval:native:classifier -- --config examples/native-balanced.json \
  --cases evals/native-routing/holdout.json --policy constraints
```

离线模式使用声明标签，验证生产 `NativeSession` 的决策过程。实际分类需要 `--live --max-calls N`；预算不足时入口会提示所需最小值。这里只运行分类器，不运行任务执行模型。

`execution/` 发布两个合成完整任务及独立验收器。原先从项目开发任务提取的源码任务不进入公开套件。

```bash
npm run eval:tasks -- --suite evals/native-routing/execution/suite.json --dry-run
```

完整执行方法与结果字段见 [任务评测](../../docs/task-evaluation.md)。
