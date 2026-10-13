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

模型与强度分别判断：明确且可逆的机械步骤可以使用专家模型 low，普通实施使用 medium，架构和诊断使用 high。指代不明或需求缺失时仍保留已有底线，不因阶段标签直接降档。普通自动分类不选择 xhigh。

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

## 显式选择 xhigh

`native-balanced.json` 和 `native-constraints-shadow.json` 提供以下原生规则：

```json
"native": {
  "expertModel": "gpt-6-astra",
  "rules": [
    { "prefix": "[sol-xhigh]", "model": "gpt-6.1-sol", "effort": "xhigh" },
    { "prefix": "[astra-xhigh]", "model": "gpt-6-astra", "effort": "xhigh" }
  ]
}
```

在 auto 模式下提交：

```text
[sol-xhigh] 深入核对这个方案的关键假设
[astra-xhigh] 分析多个系统之间的约束和失败路径
```

前缀优先于普通 `rules`，无需分类器判定这一轮的路线。shadow 只记录建议；manual 不采用前缀建议。`[deep]` 仍指定主模型 high。

仅“继续”会沿用 xhigh；新的明确请求会重新按阶段判断，可能降档。需要持续使用 xhigh 时，可再次加前缀，或通过 Codex `/model` 固定模型和强度。活动轮及工具续接不因后来输入而切换路线。

`native.rules` 只影响原生交互入口，不扩大 exec / review 的 Responses 模型池。启动时校验这些显式路线是否被模型目录支持，不支持会明确报错。修改配置后需退出并重新启动；保留会话可使用 resume。

## 容量不足时的备用策略

任务分类决定当前工作需要哪个模型和思考强度；容量重试只处理该模型暂时不能接收请求的情况。`native.capacityFallback` 控制焚诀的跨模型重试：

| 值 | 行为 |
| --- | --- |
| `off`（省略时的默认值） | 保留原路线，向用户显示容量错误 |
| `main-to-expert` | 主模型容量不足时改用专家；专家失败时不降回主模型 |
| `bidirectional` | 主模型和专家模型可以互为备用 |

开启时需配置 `native.expertModel`。公开原生示例显式选择 `main-to-expert`。此前省略该字段也会双向重试；现在需要明确选择策略，个人配置不会自动改写。

`native.capacityRetry` 控制允许备用时如何恢复；省略时为 `once`，保持原有行为：

| 值 | 行为 |
| --- | --- |
| `once` | 尚未出现回答、思考输出、工具开始或审批时，最多切换一次 |
| `until-available` | 持续尝试允许的模型，直到成功、其他错误或用户停止；执行中断后根据同一会话历史续做 |

持续模式第一次立即尝试，后续等待 1、2、4、8、16、30 秒，之后每次等待 30 秒。`main-to-expert` 切到专家后只重试专家，不降回主模型；`bidirectional` 轮换主模型和专家。`capacityFallback=off` 时两种模式都不恢复。

例如，日常会话希望持续轮换 Sol/Astra：

```json
"native": {
  "expertModel": "gpt-6-astra",
  "capacityFallback": "bidirectional",
  "capacityRetry": "until-available"
}
```

两种模式只在 auto 模式、low/medium/high 路线收到原生 `serverOverloaded` 时生效。额度耗尽和其他错误不会触发这一机制。备用模型的 low 路线使用 medium，medium/high 保持对应强度。manual、shadow 和显式 xhigh 路线不恢复。

持续模式始终发送简短的续做指令，模型通过同一会话历史读取原始任务与执行结果，避免连续失败时重复追加完整任务。续做要求先核对历史结果，不重放原始输入；这依赖执行模型正确判断已完成的操作，不是外部操作的去重保证。未回答的审批或提问、执行中补充输入、打断、手动选模型、切换会话及关闭连接会停止旧任务的恢复。等待期间同样可以取消。

持续模式也覆盖主会话接受专家意见后的自动修正；恢复仍记作自动修正，不作为新的用户输入，也不重新发起专家审查。独立的只读专家审查保持原有的超时、次数及 token 预算。

重试沿用同一会话、Plan 设置与权限，不重新分类；单次模式保留原输入，持续模式使用续做指令。日志分开记录初始路线 `requestedRoute`、任务选择原因 `selectionReason`、`retryPolicy`、重试次数及 `capacity-retry`。状态栏显示初始选择、实际提交路线、等待时间和次数，保留任务判断说明。服务端自己的模型重路由仍单独显示，不由这个选项控制。修改配置后重新启动；已有进程不会自动加载新策略。

## 分类器看到的上下文

原生入口的 `native.classifierContext` 默认是 `task`，分类器使用任务目标、历史请求和选取的工具证据。`latest-message` 仅发送最新请求，用于比较上下文的作用；它不裁剪 Codex 执行历史，也不改变模型/effort 决策规则、活动轮次固定或手动覆盖行为。指代型请求缺少历史时可能保留已有路线。

## 恢复与历史

```bash
npm start -- codex-native --config fenjue.config.json -- resume
```

恢复会话时保留手动选择与任务路线，并从可用 Codex 历史补回分类上下文。历史缺失或超过分类预算会带缺失标记，不会伪造缺失内容。分类用的裁剪视图不替换 Codex 的原始执行历史。

`[new]` 可以明确提示独立任务，`[deep]` 使用配置中的 deep 路线。恢复权限及不支持的参数见 [兼容性说明](compatibility.md)。

## 可选采集

省略 `capture` 不采集日常 case 和执行快照，但原生入口仍保存用于恢复的任务状态与运行日志，其中可能有任务文本和工具证据。需要采集时，先看 [任务评测](task-evaluation.md#从日常任务生成完整执行-case)，明确项目与路径。

运行日志与采集素材应留在本地。发布问题时使用最小合成复现，删除凭据、真实聊天和项目代码；不要直接上传整个 `.fenjue/`。
