/**
 * 纯净对话模式（Harness）IPC
 *
 * 数据流：
 *   用户输入(harness 页面) → 'harness-send' → 转发给 AI 页面(bridge) 由 sendToChat 发出
 *   AI 回复/工具事件(AI 页面 bridge) → 'harness-event-report' → 转发给 harness 页面显示
 *   切换：'harness-exit' → 隐藏 harness view，露出网页
 *
 * 依赖：仅 window.js（窗口上下文）。与官方 IPC 解耦，独立注册。
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 该窗口的 harness view 是否可见（用于状态查询） */
function getHarnessView(sender: any): any {
  const ctx = windowState.getContextByWebContents(sender);
  return ctx ? (ctx as any).harnessView : null;
}

/** 按 sender 找到对应窗口上下文（含 AI view） */
function findContext(sender: any): any {
  // sender 可能是 harness 页、AI 页、壳页
  return windowState.getContextByWebContents(sender);
}

function registerHarnessIpc(): void {
  // 用户在 harness 输入 → 转给 AI 页面（bridge 会调 sendToChat）
  ipcMain.handle('harness-send', (event: any, payload: any) => {
    console.log('[Cuckoo Harness] 收到用户消息，长度=' + ((payload && payload.text) || '').length);
    const text = payload && payload.text;
    if (!text) return { success: false, error: 'empty' };
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      return { success: false, error: 'no-ai-view' };
    }
    // 转发给 AI 页面，由 bridge/harness-bridge 执行 sendToChat（用户消息由 harness 页面本地回显）
    ctx.view.webContents.send('harness-user-message', { text: text });
    return { success: true };
  });

  // AI 页面的 bridge 上报事件（回复/工具开始/工具结束）→ 转给 harness 页面
  ipcMain.handle('harness-event-report', (event: any, payload: any) => {
    const ctx = findContext(event.sender);
    if (!ctx) return { success: false };
    const hv = (ctx as any).harnessView;
    if (hv && !hv.webContents.isDestroyed()) {
      hv.webContents.send('harness-event', payload);
    }
    return { success: true };
  });

  // 退出纯净模式，返回网页模式
  ipcMain.handle('harness-exit', (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.win) return { success: false };
    try { (ctx.win as any).__ckToggleHarness?.(false); } catch (_) {}
    return { success: true };
  });

  // harness 页面就绪（记录一次，便于确认页面/preload 已加载）
  ipcMain.on('harness-ready', () => {
    console.log('[Cuckoo Harness] 页面已就绪');
  });
}

export { registerHarnessIpc };
