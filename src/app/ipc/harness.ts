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
import { scanSkills } from '../../skills/index.js';
import { registry } from '../../tools/index.js';
import { buildInjectCode } from '../../tools/impl/attach-file.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 该窗口的 harness view 是否可见（用于状态查询） */
function getHarnessView(sender: any): any {
  const ctx = windowState.getContextByWebContents(sender);
  return ctx ? (ctx as any).harnessView : null;
}

/**
 * 按 sender 找到对应窗口上下文（含 AI view）。
 * 注意：harness view 不在官方 getContextByWebContents 的匹配范围内，故自行遍历上下文。
 */
function findContext(sender: any): any {
  for (const ctx of windowState.getAllContexts()) {
    const c: any = ctx;
    if (c.harnessView && c.harnessView.webContents === sender) return c;
    if (c.view && c.view.webContents === sender) return c;
    if (c.win && c.win.webContents === sender) return c;
  }
  return null;
}

function registerHarnessIpc(): void {
  // 用户在 harness 输入 → 转给 AI 页面（bridge 会调 sendToChat）
  // 注：允许空文本（仅附件场景：附件已上传，只需触发发送）
  ipcMain.handle('harness-send', (event: any, payload: any) => {
    console.log('[Cuckoo Harness] 收到用户消息，长度=' + ((payload && payload.text) || '').length);
    const text = (payload && payload.text) || '';
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

  // 停止生成：向 AI 页面注入脚本，查找停止按钮并点击（兜底发送 Escape）
  ipcMain.handle('harness-stop', async (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) return { success: false };
    try {
      const clickStopFn = function (doc: any, win: any) {
        try {
          var kw = /(停止|stop|停止生成|cancel|abort)/i;
          var els = doc.querySelectorAll('button, [role="button"], a, div');
          for (var i = els.length - 1; i >= 0; i--) {
            var el = els[i];
            if (!el || el.offsetWidth === 0) continue;
            var cls = (typeof el.className === 'string') ? el.className : '';
            var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
            var title = (el.getAttribute && el.getAttribute('title')) || '';
            var txt = (el.textContent || '').slice(0, 12);
            var sig = cls + ' ' + aria + ' ' + title + ' ' + txt;
            if (kw.test(sig) && /stop|停止|abort|cancel/i.test(sig)) {
              el.click();
              return true;
            }
          }
          doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return false;
        } catch (e) { return false; }
      };
      await ctx.view.webContents.executeJavaScript('(' + clickStopFn.toString() + ')(document, window)');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 列出可用技能与工具（供输入区 / 菜单）
  ipcMain.handle('harness-list-tools', async (event: any) => {
    try {
      const ctx = findContext(event.sender);
      const projectDir = ctx && ctx.sessionStore ? ctx.sessionStore.state.selectedProjectDir : null;
      const skills = scanSkills(projectDir || null).map((s: any) => ({ name: s.name, description: s.description }));
      const tools = registry.getDescriptions().map((t: any) => ({ name: t.name, description: t.description }));
      return { success: true, skills, tools };
    } catch (err: any) {
      return { success: false, error: err.message, skills: [], tools: [] };
    }
  });

  // 上传附件：harness 页面选择的文件（base64）→ 注入 AI 页面 input[type=file]
  ipcMain.handle('harness-attach', async (event: any, payload: any) => {
    const files = (payload && payload.files) || [];
    console.log('[Cuckoo Harness] harness-attach 调用, files=' + (Array.isArray(files) ? files.length : 'non-array'));
    if (!Array.isArray(files) || files.length === 0) return { success: false, error: 'empty' };
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      console.log('[Cuckoo Harness] harness-attach: 找不到 AI view');
      return { success: false, error: 'no-ai-view' };
    }
    const pageWc = ctx.view.webContents;
    const results: any[] = [];
    for (const f of files) {
      console.log('[Cuckoo Harness] 上传文件: ' + f.name + ' b64len=' + ((f.data || '').length));
      try {
        const code = buildInjectCode(f.data || '', f.name || 'file', f.mime || 'application/octet-stream', 12000, 500);
        const r = await pageWc.executeJavaScript(code, true);
        console.log('[Cuckoo Harness] 上传结果: ' + JSON.stringify(r));
        if (r && r.success) results.push({ success: true, name: f.name });
        else results.push({ success: false, name: f.name, error: (r && r.error) || '上传失败' });
      } catch (err: any) {
        console.log('[Cuckoo Harness] 上传异常: ' + err.message);
        results.push({ success: false, name: f.name, error: err.message });
      }
    }
    const ok = results.filter((x) => x.success).length;
    console.log('[Cuckoo Harness] harness-attach 完成, ok=' + ok + '/' + files.length);
    return { success: ok > 0, uploaded: ok, total: files.length, results };
  });

  // 重载 harness 页面（加载最新 HTML，无需重启应用）
  ipcMain.handle('harness-reload', (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !(ctx as any).harnessView || (ctx as any).harnessView.webContents.isDestroyed()) {
      return { success: false };
    }
    try {
      (ctx as any).harnessView.webContents.reloadIgnoringCache();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
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
