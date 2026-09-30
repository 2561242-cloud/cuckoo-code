/**
 * IPC：飞书同步
 *  - 配置读写 / 启停 / 状态查询（壳页面「飞书」页调用）
 *  - 接收 AI 页面上报（feishu-report）→ 按配置推送飞书
 *  - 飞书来消息 → 转发给当前活跃窗口的 AI 页面
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import * as feishuClient from '../../feishu/client.js';
import { readConfig, writeConfig } from '../../feishu/config.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

let feishuInited = false;

/** 飞书来消息 → 转发给"最近活跃窗口"的 AI 页面 */
function forwardUserMessage(text: string): void {
  const ctx = windowState.getMainContext();
  const view = ctx && ctx.view;
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    console.warn('[Feishu] 无活跃窗口，消息丢弃');
    return;
  }
  try {
    view.webContents.send('feishu-user-message', { text });
    console.log('[Feishu] 已转发用户消息到 AI 页面, 长度=' + text.length);
  } catch (err: any) {
    console.error('[Feishu] 转发失败:', err.message);
  }
}

/** 通知所有 AI 页面：飞书启用状态（bridge 据此决定是否上报） */
function broadcastFeishuMode(enabled: boolean): void {
  for (const ctx of windowState.getAllContexts()) {
    try {
      const v = ctx && ctx.view;
      if (v && v.webContents && !v.webContents.isDestroyed()) {
        v.webContents.send('feishu-mode', { enabled });
      }
    } catch (_) {}
  }
}

/** 初始化飞书（启动时调用：若配置为启用则自动连接） */
function initFeishu(): void {
  if (feishuInited) return;
  feishuInited = true;
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.appId || !cfg.appSecret) return;
  feishuClient.connect({
    onUserMessage: (text) => forwardUserMessage(text),
  });
  broadcastFeishuMode(true);
  console.log('[Feishu] 启动时自动连接（已启用）');
}

function registerFeishuIpc(): void {
  // bridge 初始化时查询启用状态（避免错过广播时机）
  ipcMain.handle('feishu-is-enabled', async () => {
    const cfg = readConfig();
    return { enabled: cfg.enabled === true && !!cfg.appId && !!cfg.appSecret };
  });

  // 读配置 + 状态
  ipcMain.handle('feishu-get-config', async () => {
    const cfg = readConfig();
    const st = feishuClient.getStatus();
    // 不把 appSecret 明文回传（用掩码）
    return {
      success: true,
      config: {
        appId: cfg.appId,
        appSecret: cfg.appSecret ? '••••••' : '',
        hasSecret: !!cfg.appSecret,
        enabled: cfg.enabled,
        targetOpenId: cfg.targetOpenId,
        hasTarget: !!cfg.targetOpenId,
        pushUserMessage: cfg.pushUserMessage,
        pushAiReply: cfg.pushAiReply,
        pushToolStatus: cfg.pushToolStatus,
        pushToolName: cfg.pushToolName,
      },
      status: st.status,
      statusDetail: st.detail,
    };
  });

  // 保存配置 + （按需）启停连接
  ipcMain.handle('feishu-save-config', async (_event: any, { data }: any) => {
    const d: any = { ...(data || {}) };
    // 掩码密码不回写（保留原值）
    if (d.appSecret === '••••••') delete d.appSecret;
    const ok = writeConfig(d);
    if (!ok) return { success: false, error: '保存失败' };
    const cfg = readConfig();
    // 按启用状态连接/断开
    if (cfg.enabled && cfg.appId && cfg.appSecret) {
      feishuClient.connect({ onUserMessage: (text) => forwardUserMessage(text) });
      broadcastFeishuMode(true);
    } else {
      feishuClient.disconnect();
      broadcastFeishuMode(false);
    }
    return { success: true };
  });

  // 手动重连
  ipcMain.handle('feishu-reconnect', async () => {
    const cfg = readConfig();
    if (!cfg.appId || !cfg.appSecret) return { success: false, error: '未配置凭证' };
    feishuClient.connect({ onUserMessage: (text) => forwardUserMessage(text) });
    return { success: true };
  });

  // 断开
  ipcMain.handle('feishu-disconnect', async () => {
    feishuClient.disconnect();
    broadcastFeishuMode(false);
    return { success: true };
  });

  // AI 页面上报（用户消息 / AI 回复 / 工具状态）→ 按配置推送飞书
  ipcMain.handle('feishu-report', async (_event: any, payload: any) => {
    const cfg = readConfig();
    if (!cfg.enabled) return { success: false };
    const type = payload && payload.type;
    // 统一推送 + 结果检查（失败打日志，便于排查）
    const push = async (text: string, label: string) => {
      const r = await feishuClient.sendText(text);
      if (!r.success) console.warn('[Feishu] 推送失败（' + label + '）:', r.error);
      return r;
    };
    try {
      if (type === 'user-message') {
        if (!cfg.pushUserMessage) return { success: true };
        const t = String(payload.text || '').trim();
        if (t) return await push('👤 我：' + t, 'user-message');
      } else if (type === 'ai-reply') {
        if (!cfg.pushAiReply) return { success: true };
        const t = String(payload.text || '').trim();
        if (t) return await push('🤖 AI：' + t, 'ai-reply');
      } else if (type === 'tool-start') {
        if (!cfg.pushToolStatus) return { success: true };
        return await push(cfg.pushToolName && payload.toolName ? '🔧 正在调用工具：' + payload.toolName : '🔧 AI 正在调用工具…', 'tool-start');
      } else if (type === 'tool-end') {
        if (!cfg.pushToolStatus) return { success: true };
        return await push('✅ 工具调用完成', 'tool-end');
      }
    } catch (err: any) {
      console.error('[Feishu] 推送异常:', err.message);
      return { success: false, error: err.message };
    }
    return { success: true };
  });
}

export { registerFeishuIpc, initFeishu, broadcastFeishuMode };
