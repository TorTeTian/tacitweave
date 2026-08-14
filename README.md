# TacitWeave

> **测试项目 / TEST ONLY.** 这是用于体验和研究显式 Personal Model → Interaction Policy → 用户校准流程的早期原型。它不是成熟的安全产品，不能替代 DSH 自身的沙箱、审批或权限控制。

**TacitWeave** 把原本隐含的个人偏好编织成当前任务可执行、可校准的协作策略。这个 DSH bundle 把可审阅的个人记忆文件注入每一步模型上下文，并提供真正暂停等待用户回答的 `tacitweave_calibrate` 工具。若模型绕过校准直接调用配置中的副作用工具，插件会在 DSH 工具策略层拒绝该调用。

## 当前能力

- 从项目的 `.personal-model/personal_model.json` 和 `current_context.md` 读取记忆；
- 每个新任务生成 `act / ask / propose / explain_then_act` 策略；
- 在自适应条件下弹出校准问题，等待确认、修改或跳过个性化；
- 将每轮策略保存到 `.personal-model/policies/<session>/turn-<n>.json`；
- 将校准记录追加到 `.personal-model/feedback.jsonl`；
- 对未校准的写文件、Shell、终端、委派和动态插件等工具进行拦截；
- 导出一份经基础敏感信息过滤、可人工复核的项目上下文 Markdown。

## 已验证目标

- DeepSeek Harness Developer Preview `0.1.0-rc.6`；
- Node.js 22.19+ / 24；
- Windows 作为首要体验环境。

DSH 目前明确处于 Developer Preview，后续可能发生破坏性接口变更。本插件因此把存储和策略核心与 DSH 适配层分开。

## 安装到 DSH

先安装并运行官方 DSH：

```powershell
npx @deepseek-ai/dsh web
```

从本地 checkout 安装测试版：

```powershell
dsh plugin --profile web add D:\PythonProjects\man_ai_interaction
dsh --profile web --dump-config
dsh web
```

从 GitHub 安装时可使用：

```powershell
dsh plugin --profile web add github:TorTeTian/tacitweave
```

仓库使用纯 JavaScript，GitHub 安装不需要执行 `prepare` 构建脚本。建议固定 commit，不要追踪浮动分支。

## 第一次体验

在项目根目录启动 DSH。可以先问：

> 请调用 tacitweave_inspect，告诉我当前加载了哪些记忆文件和偏好。

然后给出一个会修改文件的任务。模型应先调用 `tacitweave_calibrate`，界面会展示：

- 当前任务；
- 建议协作方式；
- AI 可自主处理的事项；
- 保留给用户的决定；
- 风险和置信度。

如果模型尝试直接写文件，工具调用会被拒绝，并提示先完成校准。

## 查看记忆

所有项目记忆都在：

```text
.personal-model/
  personal_model.json
  current_context.md
  policies/
  feedback.jsonl
```

`.personal-model/` 默认被 Git 忽略，避免把真实个人记忆推到公开仓库。去个性化模板位于 `examples/memory/`；如果你确实希望对个人记忆进行版本控制，需要在理解隐私影响后自行调整忽略规则。

插件不会根据一次模型推断直接修改 `personal_model.json`。用户在校准中的修正先写入反馈日志，便于人工审阅后再提升为长期偏好。

## 导出项目上下文

```powershell
node .\bin\export-context.mjs --root . --output .\.personal-model\exports\current-context.md
```

导出器默认排除 `.git`、依赖目录、虚拟环境、`work`、常见密钥文件和疑似令牌，并限制单文件及总大小。自动过滤不可能保证无敏感信息，喂给任何模型之前必须人工检查输出。

## 配置

安装后的 bundle 默认读取当前工作目录下的 `.personal-model`。可在 profile 的 `cordis.patch.yml` 中完整覆盖 `tacitweave` 行。主要字段：

- `memoryDir`：记忆目录；
- `calibrationMode`：`always`、`adaptive` 或 `off`；
- `maxMemoryChars`：每步注入的最大记忆字符数；
- `gatedTools`：必须先校准的工具名列表。

## ChatGPT 桌面端状态

V0.1 不提供 ChatGPT 桌面端的强制执行拦截。当前 DSH 暴露了系统提示、用户问题和工具调用前策略三条扩展缝，而 ChatGPT 桌面端没有等价的本地插件权限面。上下文导出的 Markdown 可以手工提供给 ChatGPT，但那只实现可移植上下文，不实现不可绕过的执行前校准。

## 场景数据

- 编写规范：[`docs/SCENARIO_SPEC.md`](docs/SCENARIO_SPEC.md)
- JSON Schema：[`scenarios/scenario.schema.json`](scenarios/scenario.schema.json)
- 20 个场景：[`scenarios/transfer-scenarios.json`](scenarios/transfer-scenarios.json)

## 验证

```powershell
npm run check
npm test
npm run pack:dry
```

## 明确限制

- 首版依靠模型调用校准工具；工具策略拦截覆盖配置中的副作用工具，但无法阻止纯文本回答中的越权建议。
- 风险分类本身仍由模型完成，尚未接入独立分类器。
- 个人模型文件没有自动冲突消解或版本迁移。
- 未经过正式用户研究，不声称改善协作质量。
