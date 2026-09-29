---
id: 017
type: feature
title: 纯净对话模式（Harness 模式，类 Codex 体验）
status: done
branch: feat/017-harness-mode
created: 2026-09-29
updated: 2026-09-29
---

## 背景

现有 Cuckoo Code 直接展示 AI 网页 + 覆盖层。用户在界面上会看到系统提示词、工具执行结果回传、格式纠正提示等"底层对话指令"，体验偏向开发者面板，而非纯粹的对话。

希望提供类似 Codex 等主流 harness 的体验：一个只保留「用户 ↔ 模型」对话与工具调用记录的纯净界面，隐藏所有底层指令。

## 目标

- 新增"纯净模式"：在**同一窗口内**切换到类 Codex 的对话界面（AI 网页退居后台）
- 只显示三类内容：① 用户消息 ② 模型文本回复 ③ 工具调用卡片（含执行结果）
- 不显示：系统提示词、工具结果回传消息、JSON/XML 格式纠正提示等一切"底层指令"
- AI 网页继续在后台正常运行（hook 拦截、工具循环照旧）
- **与官方源码解耦**：新增代码集中在独立文件；对官方文件的改动仅限少量向后兼容新增

## 方案

### 总体

在现有窗口内增加一个覆盖式 \`WebContentsView\`（harness view），承载纯净 UI 页面，默认隐藏，盖在 AI 网页之上。AI 网页 bounds 不变、继续运行，仅被遮挡。

入口：
- 快捷键 \`Ctrl+Shift+H\`（AI 页面 / harness 页面 / 壳页面 内均可触发切换）
- 菜单「查看 → 纯净对话模式」
- harness 页面内「网页模式」按钮

### 新增文件（独立，尽量零耦合）

| 文件 | 职责 |
|---|---|
| \`src/ui/harness.html\` | 纯净对话流页面（Codex 风格，内联 CSS/JS，无外部依赖） |
| \`src/app/harness-preload.ts\` | harness 页面 preload，暴露 \`window.harnessAPI\` |
| \`src/bridge/harness-bridge.ts\` | bridge 侧：上报 AI 回复/工具调用、接收用户消息 |
| \`src/app/ipc/harness.ts\` | 主进程 IPC：发送、事件中转、显隐切换 |

### 对官方文件的改动（全部为向后兼容的新增）

| 文件 | 改动 |
|---|---|
| \`src/app/entry.ts\` | 创建 harness view + 布局 + 快捷键 + 菜单项 |
| \`src/app/ipc/index.ts\` | 注册 harness IPC（2 行） |
| \`src/bridge/entry.ts\` | import 并调用 initHarnessBridge（2 行） |
| \`src/bridge/intercept/observer.ts\` | 新增可选 \`onToolCall\` 回调 + 导出（约 20 行，无监听者时零开销） |

### 数据流

\`\`\`
用户输入(harness) → harness-send(IPC) → 主进程 → AI view.send('harness-user-message')
  → bridge/harness-bridge → sendToChat() → AI 网页

AI 回复 → hook → observer → onInterceptedResponse
  → bridge/harness-bridge(去工具代码块) → harness-event-report(IPC) → 主进程 → harness view.send('harness-event')

工具执行 → observer.emitToolCall(新增回调) → bridge/harness-bridge
  → harness-event-report(IPC) → 主进程 → harness view.send('harness-event')
\`\`\`

### 纯净性保障

系统提示词、工具结果回传、格式纠正提示均由框架经 \`sendToChat\` 发出，**不经过 harness 记录**；harness 只记录自己输入的用户消息、AI 回复（剥离工具代码块后）、工具卡片，故底层指令天然不显示。

### 关键决策

- **方案 A（允许少量向后兼容新增）而非方案 B（纯监听 DOM）**：把数据通道固定为稳定的回调契约（\`onToolCall\`），而非耦合 DOM id / 事件名，官方重构时更不易失效。代价仅是一个可选回调。
- **方案 ①（同窗口覆盖视图）而非独立窗口**：复用 provider/session/partition，切换即时，布局改动小。

## 验收标准

- [x] 可切换到纯净模式，显示 Codex 风格对话流
- [x] 用户消息、模型回复、工具调用卡片正确显示（数据链路实现完成）
- [x] 系统提示词、工具结果回传等底层指令不显示
- [x] AI 网页后台照常工作，工具循环正常
- [x] 可切回网页模式
- [x] typecheck / test / lint / compile 全通过

## 后续迭代（2026-09-29 同日）

### 流式输出 + 思考过程

初版只显示最终回复（hook 仅在结束时派发一次）。为对齐主流 harness 体验，补充：

- **hook 新增流式事件** \`cuckoo-ai-stream\`（deepseek/claude/chatgpt 三平台，纯新增，节流 80ms）
  - deepseek：暴露已有 \`thinkText\`；claude：新增捕获 \`thinking_delta\`
  - \`dispatchStream(think, text, finished)\`，text/think 均为全量快照
- **observer 新增 \`onStream\` 回调**（向后兼容，无监听者零开销）
- **harness-bridge** 上报 \`stream\` 事件；完成时发 \`assistant-done\`
- **UI**：流式渲染 + 光标；思考过程折叠块（正文出现后自动折叠，可手动展开）

### UI 重做（Claude Code 风格）

- 暖色强调（#d97757）、深色极简、助手消息无气泡（前缀标记 + 正文）
- 工具卡片：名称 + 参数 + 状态徽章，成功自动折叠
- 全部图标为内联 SVG（无 emoji）

## 遗留 / 后续

- 对话往返的真机端到端验证需在**已登录 AI 平台**的会话中进行（dev 隔离 profile 未登录，仅验证到页面加载与渲染）。
- 当前 harness 对话流不落盘（刷新即清空）；后续可考虑持久化历史。
- 工具卡片目前按"最近一张未完成卡片"匹配 start/end，若并发多工具可能需更精确的 callId 关联（当前 observer 逐块执行，实际为串行，无影响）。
- 未处理 \`status\` 事件的"等待模型"态在 AI 回复为空时可能不重置（回复为空则不显示 assistant 气泡），后续可加超时兜底。
