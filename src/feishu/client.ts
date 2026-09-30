/**
 * 飞书同步：客户端（长连接 + 收发消息）
 *
 * 用飞书官方 SDK（@larksuiteoapi/node-sdk）：
 *  - WSClient：长连接接收事件（无需公网 IP）
 *  - Client：发消息
 *
 * 主进程内存态：连接实例 + 状态。配置变更时由外部调用 connect/disconnect。
 * 本模块依赖 electron?否——纯 Node。但 SDK 是 CJS，用 createRequire 加载。
 */
import { createRequire } from 'node:module';
import { readConfig, writeConfig } from './config.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lark = require('@larksuiteoapi/node-sdk');

/** 连接状态 */
type FeishuStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface FeishuCallbacks {
  /** 收到用户从飞书发来的消息 */
  onUserMessage?: (text: string) => void;
  /** 状态变化（供 UI 刷新） */
  onStatusChange?: (status: FeishuStatus, detail?: string) => void;
}

let wsClient: any = null;
let apiClient: any = null;
let currentStatus: FeishuStatus = 'disconnected';
let statusDetail = '';
let callbacks: FeishuCallbacks = {};

function setStatus(s: FeishuStatus, detail?: string): void {
  currentStatus = s;
  statusDetail = detail || '';
  try { callbacks.onStatusChange?.(s, statusDetail); } catch (_) {}
}

function getStatus(): { status: FeishuStatus; detail: string; hasTarget: boolean } {
  const cfg = readConfig();
  return { status: currentStatus, detail: statusDetail, hasTarget: !!cfg.targetOpenId };
}

/** 从事件中提取纯文本（只处理文本消息） */
function extractText(event: any): string {
  try {
    const msg = event && event.message;
    if (!msg) return '';
    if (msg.message_type !== 'text') return ''; // 只处理文本
    const content = JSON.parse(msg.content || '{}');
    return typeof content.text === 'string' ? content.text : '';
  } catch (_) {
    return '';
  }
}

/** 启动长连接（幂等：先断开旧的） */
function connect(cb?: FeishuCallbacks): { success: boolean; error?: string } {
  if (cb) callbacks = cb;
  const cfg = readConfig();
  if (!cfg.appId || !cfg.appSecret) {
    setStatus('error', '缺少 App ID / App Secret');
    return { success: false, error: '缺少 App ID / App Secret' };
  }
  // 先断开旧的
  disconnect(true);
  setStatus('connecting');

  try {
    apiClient = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        console.log('[Feishu] ★ 收到 im.message.receive_v1 事件');
        try {
          // 记录推送目标（用户首次发消息时）
          const sender = data && data.sender;
          const openId = sender && sender.sender_id && sender.sender_id.open_id;
          if (openId) {
            const cur = readConfig();
            if (cur.targetOpenId !== openId) {
              writeConfig({ targetOpenId: openId });
              console.log('[Feishu] 已记录推送目标 open_id:', openId);
            }
          }
          const text = extractText(data);
          if (text) {
            console.log('[Feishu] 收到用户消息, 长度=' + text.length);
            try { callbacks.onUserMessage?.(text); } catch (_) {}
          }
        } catch (err: any) {
          console.error('[Feishu] 处理消息失败:', err.message);
        }
      },
    });

    wsClient = new lark.WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      loggerLevel: lark.LoggerLevel.info,
      onReady: () => { console.log('[Feishu] 长连接就绪(onReady)'); setStatus('connected'); },
      onError: (err: any) => setStatus('error', (err && err.message) || String(err)),
      onReconnecting: () => setStatus('connecting', '重连中…'),
      onReconnected: () => setStatus('connected'),
    });
    wsClient.start({ eventDispatcher: dispatcher });
    return { success: true };
  } catch (err: any) {
    setStatus('error', err.message);
    return { success: false, error: err.message };
  }
}

/** 断开连接。@param silent 不更新状态（供内部切换用） */
function disconnect(silent?: boolean): void {
  try {
    if (wsClient) wsClient.close({});
  } catch (_) {}
  wsClient = null;
  apiClient = null;
  if (!silent) setStatus('disconnected');
}

/** 发送文本消息给记录的推送目标 */
async function sendText(text: string): Promise<{ success: boolean; error?: string }> {
  const cfg = readConfig();
  if (!apiClient) {
    // 没连接时惰性建一个（仅发消息）
    if (!cfg.appId || !cfg.appSecret) return { success: false, error: '未配置' };
    apiClient = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });
  }
  if (!cfg.targetOpenId) {
    return { success: false, error: '还没有推送目标（请先在飞书里给机器人发一条消息）' };
  }
  try {
    const res = await apiClient.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: cfg.targetOpenId,
        msg_type: 'text',
        content: JSON.stringify({ text: text }),
      },
    });
    if (res && (res.code === 0 || res.code === undefined)) return { success: true };
    return { success: false, error: (res && res.msg) || '发送失败' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export { connect, disconnect, sendText, getStatus, readConfig };
export type { FeishuStatus };
