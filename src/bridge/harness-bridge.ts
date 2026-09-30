/**
 * 纯净对话模式（Harness）的 bridge 侧逻辑
 *
 * 运行在 AI 页面（preload）。职责：
 *   1. 订阅 AI 回复（onInterceptedResponse）→ 上报主进程 → harness 页面显示
 *   2. 订阅工具调用事件（onToolCall）→ 上报；解析 todoWrite → 上报计划
 *   3. 监听主进程转发的 'harness-user-message' → 调 sendToChat 发到 AI
 *   4. 目标模式：识别 [[GOAL_DONE]] 标记 → 上报 goal-done
 *
 * 与官方解耦：仅在 bridge/entry.ts 中 import 激活；其余为独立文件。
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
  out = out.replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*?```/gi, '');
  // 流式输出中途：代码块尚未闭合 → 从开标记起全部隐藏，避免 ```cuckoo 内容闪现
  out = out.replace(/```(?:cuckoo|javascript|js)\s*\n[\s\S]*$/gi, '');
  out = out.replace(/```(?:cuckoo|javascript|js)\s*$/gi, '');
  return out.trim();
}

/** 目标完成标记（AI 输出即视为目标达成） */
const GOAL_DONE_RE = /\[\[GOAL_DONE\]\]/;

/** 从工具代码中解析 todoWrite 的待办列表（容错正则，失败返回 null） */
function parseTodos(code: string): any[] | null {
  if (!code || code.indexOf('todoWrite') < 0) return null;
  const items: any[] = [];
  const re = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const blk = m[0];
    const c = blk.match(/content\s*:\s*(['"`])([\s\S]*?)\1/);
    const s = blk.match(/status\s*:\s*(['"`])([\s\S]*?)\1/);
    if (c && s) items.push({ content: c[2], status: s[2] });
  }
  return items.length ? items : null;
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

  // 纯净模式开关：关闭时各监听回调立即返回（正则/IPC 零开销，降后台负担）
  let enabled = false;
  ipcRenderer.on('harness-mode', (_e: any, payload: any) => {
    enabled = !!(payload && payload.enabled);
  });

  // 流式增量 → 上报
  onStream((ev: any) => {
    if (!enabled) return;
    let t = stripToolBlocks(ev.text || '');
    t = t.replace(GOAL_DONE_RE, '').trim();
    report({ type: 'stream', think: ev.think || '', text: t, finished: !!ev.finished });
  });

  // AI 回复完成 → 上报（含 goal-done 检测）
  onInterceptedResponse((text: string) => {
    if (!enabled) return;
    const raw = text || '';
    const goalDone = GOAL_DONE_RE.test(raw);
    const clean = stripToolBlocks(raw).replace(/\[\[GOAL_DONE\]\]/g, '').trim();
    report({ type: 'assistant-done', text: clean });
    if (goalDone) report({ type: 'goal-done' });
  });

  // 工具调用事件 → 上报（含计划解析）
  onToolCall((ev: any) => {
    if (!enabled || !ev) return;
    if (ev.phase === 'start') {
      report({ type: 'tool-start', code: ev.code });
      const todos = parseTodos(ev.code || '');
      if (todos) report({ type: 'plan', todos });
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
