/**
 * 地址栏壳页面 preload（与 AI 页面 preload 分离）
 * 暴露 window.shellAPI：导航控制 + 地址变化订阅。不能有顶层 await（P3a 教训）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const shellAPI = {
  navigate: (url: string) => ipcRenderer.invoke('shell-navigate', { url }),
  back: () => ipcRenderer.invoke('shell-back'),
  forward: () => ipcRenderer.invoke('shell-forward'),
  reload: () => ipcRenderer.invoke('shell-reload'),
  home: () => ipcRenderer.invoke('shell-home'),
  onUrlUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-url-updated', (_e: any, data: any) => cb(data));
  },
  onTokenUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-token-updated', (_e: any, data: any) => cb(data));
  },
  onTotalUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-total-updated', (_e: any, data: any) => cb(data));
  },
  getSystemTotal: () => ipcRenderer.invoke('get-system-total'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getSkills: () => ipcRenderer.invoke('shell-get-skills'),
  triggerSkill: (text: string) => ipcRenderer.invoke('shell-trigger-skill', { text }),
  onAgentUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('shell-agent-updated', (_e: any, data: any) => cb(data));
  },
  getAgentStatus: () => ipcRenderer.invoke('get-agent-status'),
  // 自绘标题栏窗口控制
  winClose: () => ipcRenderer.invoke('shell-win-close'),
  winMinimize: () => ipcRenderer.invoke('shell-win-minimize'),
  winToggleMaximize: () => ipcRenderer.invoke('shell-win-toggle-maximize'),
};

try {
  contextBridge.exposeInMainWorld('shellAPI', shellAPI);
} catch (err) {
  console.error('[Cuckoo Shell] contextBridge 失败:', err);
}
(window as any).shellAPI = shellAPI;
