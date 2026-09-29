/**
 * 纯净对话模式（Harness）的 bridge 侧逻辑
 *
 * 运行在 AI 页面（preload）。职责：
 *   1. 订阅 AI 回复（onInterceptedResponse）→ 上报主进程 → harness 页面显示
 *   2. 订阅工具调用事件（onToolCall，observer 新增回调）→ 上报
 *   3. 监听主进程转发的 'harness-user-message' → 调 sendToChat 发到 AI
 *
 * 与官方解耦：仅在 bridge/entry.ts 中 import 激活；其余为独立文件。
 * 依赖遵循 bridge 规则（可用 observer / overlay）。
 */
import { createRequire } from 'node:module';
import { onInterceptedResponse, onToolCall, onStream } from './intercept/observer.js';
import { sendToChat } from '../overlay/chat-input.js';

const require = createRequire(import.meta.url);
const { ipcRenderer } = require('electron');

/** 移除文本中的 cuckoo / js 工具代码块（工具调用改由卡片展示） */
function stripToolBlocks(text: string): string {
  if (!text) return '';
  let out = text;
  // 移除 ```cuckoo ... ``` 与 ```js ... ``` 围栏块
  out = out.replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*?```/gi, '');
  return out.trim();
}

function report(payload: any): void {
  try {
    ipcRenderer.invoke('harness-event-report', payload).catch(() => {});
  } catch (_) { /* ignore */ }
}

/** 初始化 harness bridge（幂等） */
let inited = false;
export function initHarnessBridge(): void {
  if (inited) return;
  inited = true;

  // 流式增量 → 上报（实时渲染，含思考过程）
  // 流式阶段的 text 也剥离工具代码块（未闭合的围栏由完成时的 assistant-done 兜底修正）
  onStream((ev: any) => {
    report({ type: 'stream', think: ev.think || '', text: stripToolBlocks(ev.text || ''), finished: !!ev.finished });
  });

  // AI 回复完成 → 上报最终文本（去掉工具代码块）
  onInterceptedResponse((text: string) => {
    report({ type: 'assistant-done', text: stripToolBlocks(text || '') });
  });

  // 工具调用事件 → 上报
  onToolCall((ev: any) => {
    if (!ev) return;
    if (ev.phase === 'start') {
      report({ type: 'tool-start', code: ev.code });
    } else if (ev.phase === 'end') {
      report({
        type: 'tool-end',
        code: ev.code,
        success: !!ev.success,
        output: ev.output || '',
        error: ev.error || '',
      });
    }
  });

  // 用户在 harness 输入 → 主进程转发到此 → 发到 AI
  ipcRenderer.on('harness-user-message', (_e: any, payload: any) => {
    const text = payload && payload.text;
    if (!text) return;
    sendToChat(text, 'harness', 300).catch(() => {});
  });
}
