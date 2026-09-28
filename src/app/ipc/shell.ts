/**
 * IPC：地址栏壳页面（shell）的导航控制
 * 壳页面通过 window.shellAPI 调用这些通道操作下方 WebContentsView 中的 AI 页面。
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { getProvider } from '../../providers/registry.js';
import { setWindowCumulative, getTotal, cleanupSubagentKeys } from '../token-stats.js';
import { getAgentStatus, pushAgentStatusTo } from '../agent-status.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 取事件来源的壳窗口（标题栏按钮所在窗口） */
function winOf(event: any): any {
  const { BrowserWindow } = require('electron');
  return BrowserWindow.fromWebContents(event.sender);
}

/** 取事件来源对应的 AI 页面 view */
function viewOf(event: any): any {
  return windowState.getViewByWebContents(event.sender);
}

/** 把当前 URL 与前进/后退可用状态推送给壳页面 */
function pushUrlState(view: any): void {
  if (!view || !view.webContents || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  const ctx = windowState.getContextByWebContents(wc);
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
  const history = wc.navigationHistory;
  ctx.win.webContents.send('shell-url-updated', {
    url: wc.getURL(),
    canGoBack: history ? history.canGoBack() : false,
    canGoForward: history ? history.canGoForward() : false,
  });
}

/** 把系统总累计广播给所有窗口的壳页面 */
function broadcastSystemTotal(): void {
  const total = getTotal();
  for (const ctx of windowState.getAllContexts()) {
    try {
      if (ctx && ctx.win && !ctx.win.isDestroyed()) {
        ctx.win.webContents.send('shell-total-updated', { systemTotal: total });
      }
    } catch (_) {}
  }
}

/** 把 token 数据推送给壳页面的状态条 */
function pushTokenUsage(view: any, context: number, cumulative: number, windowCumulative = 0, todayCumulative = 0): void {
  const ctx = view ? windowState.getContextByWebContents(view.webContents) : null;
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
  ctx.win.webContents.send('shell-token-updated', { context, cumulative, windowCumulative, todayCumulative });
}

function registerShellIpc(): void {
  // 启动时清理子代理遗留的 token 统计键（历史 bug：子代理上报污染系统总累计）
  try { cleanupSubagentKeys(); } catch (_) { /* ignore */ }
  // AI 页面报告 token（上下文 + 对话累计 + 窗口累计 + 今日累计）→ 转发给壳页面状态条
  ipcMain.handle('update-token-usage', async (event: any, { context, cumulative, windowCumulative, todayCumulative }: any) => {
    const view = viewOf(event);
    if (view && typeof context === 'number') {
      pushTokenUsage(
        view,
        context,
        typeof cumulative === 'number' ? cumulative : 0,
        typeof windowCumulative === 'number' ? windowCumulative : 0,
        typeof todayCumulative === 'number' ? todayCumulative : 0
      );
    }
    // 更新系统总累计并广播给所有窗口
    try {
      const ctx = view ? windowState.getContextByWebContents(view.webContents) : null;
      // 子代理窗口跳过：它与父窗口共享 partition/localStorage，
      // windowCumulative 等于父窗口的值，上报会重复计入系统总累计。
      const isSubagent = ctx && ctx.profileId && String(ctx.profileId).startsWith('subagent-');
      if (ctx && ctx.profileId && !isSubagent && typeof windowCumulative === 'number') {
        setWindowCumulative(ctx.profileId, windowCumulative);
        broadcastSystemTotal();
      }
    } catch (_) {}
    return { success: true };
  });

  // 查询当前系统总累计（壳页面加载时拉取一次）
  ipcMain.handle('get-system-total', async () => {
    return { success: true, systemTotal: getTotal() };
  });

  // 查询应用版本（标题栏显示用）
  ipcMain.handle('get-app-version', async () => {
    const { app } = require('electron');
    return { success: true, version: app.getVersion() };
  });

  // 查询已启用的应用级技能（快捷按钮栏用）
  ipcMain.handle('shell-get-skills', async () => {
    try {
      const { listSkills } = require('../../skills/config.js');
      const skills = (listSkills() || [])
        .filter((s: any) => s.enabled !== false)
        .map((s: any) => ({ id: s.id, name: s.name, triggers: s.triggers || [] }));
      return { success: true, skills };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 点击技能按钮：把文本填入 AI 页面输入框（只填不发，主进程直接操作 DOM）
  ipcMain.handle('shell-trigger-skill', async (event: any, { text }: any) => {
    const view = viewOf(event);
    if (!view || !view.webContents || view.webContents.isDestroyed()) return { success: false };
    const safe = JSON.stringify(String(text || ''));
    const code = '(function(){try{' +
      'var t=' + safe + ';' +
      'var el=document.querySelector("textarea")||document.querySelector("[contenteditable=true]")||document.querySelector("div[contenteditable]");' +
      'if(!el)return "no-input";' +
      'el.focus();' +
      'if(el.tagName==="TEXTAREA"){' +
      'var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;' +
      'setter.call(el,t);' +
      '}else{el.textContent=t;}' +
      'el.dispatchEvent(new Event("input",{bubbles:true}));' +
      'return "ok";' +
      '}catch(e){return "err:"+e.message;}})()';
    try {
      const res = await view.webContents.executeJavaScript(code);
      return { success: true, result: res };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // 查询当前子代理运行状态（壳页面加载时拉取一次）
  ipcMain.handle('get-agent-status', async () => {
    return { success: true, agents: getAgentStatus() };
  });

  // ========== 自绘标题栏：窗口控制（仿 macOS 圆点） ==========
  ipcMain.handle('shell-win-close', async (event: any) => {
    const win = winOf(event);
    if (win && !win.isDestroyed()) win.close();
    return { success: true };
  });

  ipcMain.handle('shell-win-minimize', async (event: any) => {
    const win = winOf(event);
    if (win && !win.isDestroyed()) win.minimize();
    return { success: true };
  });

  ipcMain.handle('shell-win-toggle-maximize', async (event: any) => {
    const win = winOf(event);
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
    return { success: true };
  });


  ipcMain.handle('shell-navigate', async (event: any, { url }: any) => {
    const view = viewOf(event);
    if (!view || !url) return { success: false };
    try {
      await view.webContents.loadURL(url);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('shell-back', async (event: any) => {
    const view = viewOf(event);
    if (view && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
    return { success: true };
  });

  ipcMain.handle('shell-forward', async (event: any) => {
    const view = viewOf(event);
    if (view && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
    return { success: true };
  });

  ipcMain.handle('shell-reload', async (event: any) => {
    const view = viewOf(event);
    if (view) view.webContents.reload();
    return { success: true };
  });

  ipcMain.handle('shell-home', async (event: any) => {
    const view = viewOf(event);
    if (!view) return { success: false };
    const ctx = windowState.getContextByWebContents(view.webContents);
    if (!ctx || !ctx.providerId) return { success: false };
    const provider = getProvider(ctx.providerId);
    if (!provider) return { success: false };
    try {
      await view.webContents.loadURL(provider.homeUrl);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}

export { registerShellIpc, pushUrlState, pushTokenUsage, pushAgentStatusTo };
