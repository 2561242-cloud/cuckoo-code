/**
 * IPC：地址栏壳页面（shell）的导航控制
 * 壳页面通过 window.shellAPI 调用这些通道操作下方 WebContentsView 中的 AI 页面。
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { getProvider } from '../../providers/registry.js';
import { setWindowCumulative, getTotal, cleanupSubagentKeys } from '../token-stats.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

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

/** 把项目目录推送给壳页面（地址栏最左） */
function pushProjectDir(view: any, dir: string | null): void {
  const ctx = view ? windowState.getContextByWebContents(view.webContents) : null;
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
  ctx.win.webContents.send('shell-project-dir', dir || null);
}

/** 把 token 数据推送给壳页面的状态条 */
function pushTokenUsage(view: any, context: number, cumulative: number, windowCumulative = 0, todayCumulative = 0, daily: any = null): void {
  const ctx = view ? windowState.getContextByWebContents(view.webContents) : null;
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
  ctx.win.webContents.send('shell-token-updated', { context, cumulative, windowCumulative, todayCumulative, daily });
}

function registerShellIpc(): void {
  // 启动时清理子代理遗留的 token 统计键（历史 bug：子代理上报污染系统总累计）
  try { cleanupSubagentKeys(); } catch (_) { /* ignore */ }
  // AI 页面报告 token（上下文 + 对话累计 + 窗口累计 + 今日累计）→ 转发给壳页面状态条
  ipcMain.handle('update-token-usage', async (event: any, { context, cumulative, windowCumulative, todayCumulative, daily }: any) => {
    const view = viewOf(event);
    if (view && typeof context === 'number') {
      pushTokenUsage(
        view,
        context,
        typeof cumulative === 'number' ? cumulative : 0,
        typeof windowCumulative === 'number' ? windowCumulative : 0,
        typeof todayCumulative === 'number' ? todayCumulative : 0,
        Array.isArray(daily) ? daily : null
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

  // 查询当前项目目录（壳页面加载时拉取一次）
  ipcMain.handle('get-project-dir', async (event: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const dir = (ctx && ctx.sessionStore && ctx.sessionStore.state && ctx.sessionStore.state.selectedProjectDir) || null;
    return { success: true, dir };
  });

  // 设置左侧 Cuckoo 侧边栏宽度（收起=46，展开=320）→ 重新布局 AI 页面
  ipcMain.handle('shell-toggle-sidebar', async (event: any, { width }: any) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx || !ctx.win || ctx.win.isDestroyed()) return { success: false };
    const win = ctx.win;
    win.__ckSidebarWidth = typeof width === 'number' ? width : 320;
    try { if (typeof win.__ckLayout === 'function') win.__ckLayout(); } catch (_) {}
    return { success: true };
  });
}

export { registerShellIpc, pushUrlState, pushTokenUsage, pushProjectDir };
