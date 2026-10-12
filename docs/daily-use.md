# 配置、启动与恢复

先按 [README](../README.md) 安装和构建。配置文件与密钥由使用者提供，公开示例默认不开启采集。

## 配置选择

| 示例 | 用途 | 分类密钥 |
| --- | --- | --- |
| `examples/native-balanced.json` | 原生主模型三档与可选专家模型，默认 shadow | `AI_GATEWAY_API_KEY` |
| `examples/native-constraints-shadow.json` | 按约束耦合选择专家的实验候选 | `AI_GATEWAY_API_KEY` |
| `examples/single-model.json` | 固定前缀规则，不调用分类器 | 无 |
| `examples/semantic-shadow.json` | TypeSafe 分类器、Responses 入口 | `TYPESAFE_API_KEY` |
| `examples/kev-shadow.json` | 独立部署的本地 Kev 分类器 | 依本地服务配置 |

原生配置的 fast / balanced / deep 路线必须为同一主模型的 low / medium / high。`native.expertModel` 是可选的专家模型；运行时检查本机 Codex 模型目录是否支持指定模型与强度。

本地 Kev 示例没有 `native` 字段。用于原生入口时，复制配置并增加 `"native": {}`；如需专家模型，再指定 `expertModel`。Kev 服务需独立安装和启动，Fenjue 不分发服务或模型权重。

配置字段以 [src/config.ts](../src/config.ts) 的校验为准；不在此承诺所有账号都支持示例模型。

## 启动和模式控制

```bash
npm start -- codex-native --config fenjue.config.json \
  --env-file /path/to/gateway.env
```

`--env-file` 只读取所选分类器需要的密钥。其他 Codex 参数放在 `--` 后。可以通过 `FENJUE_CODEX_BIN` 指定 Codex 可执行文件。

- `shadow`：执行保持当前路线，记录分类建议。
- `auto`：提交新轮次前应用路由建议。
- `manual`：保持手动路线。

F8 菜单中的 a / m / s 分别切换以上模式。`/model` 会暂停自动路由。状态栏显示实际提交的模型和强度，当前轮次不因模式切换而改变。

没有 tmux 底栏时，启动输出提供控制 socket。使用显示的实际路径：

```bash
npm start -- routing auto --socket /path/from/startup
npm start -- status --watch
```

## 恢复与历史

```bash
npm start -- codex-native --config fenjue.config.json -- resume
```

恢复会话时保留手动选择与任务路线，并从可用 Codex 历史补回分类上下文。历史缺失或超过分类预算会带缺失标记，不会伪造缺失内容。分类用的裁剪视图不替换 Codex 的原始执行历史。

`[new]` 可以明确提示独立任务，`[deep]` 使用配置中的 deep 路线。恢复权限及不支持的参数见 [兼容性说明](compatibility.md)。

## 可选采集

省略 `capture` 不采集日常 case 和执行快照。需要采集时，先看 [任务评测](task-evaluation.md#从日常任务生成完整执行-case)，明确项目与路径。

运行日志与采集素材应留在本地。发布问题时使用最小合成复现，删除凭据、真实聊天和项目代码；不要直接上传整个 `.fenjue/`。
