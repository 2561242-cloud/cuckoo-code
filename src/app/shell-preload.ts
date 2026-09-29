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
  getProjectDir: () => ipcRenderer.invoke('get-project-dir'),
  // 点击"项目目录" → 弹目录选择框 + 重新初始化（复用 init-project 通道）
  initProject: () => ipcRenderer.invoke('init-project', {}),
  onProjectDir: (cb: (dir: string | null) => void) => {
    ipcRenderer.on('shell-project-dir', (_e: any, dir: any) => cb(dir));
  },
  toggleSidebar: (width: number) => ipcRenderer.invoke('shell-toggle-sidebar', { width }),
  // ========== 窗口管理 ==========
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  listProviders: () => ipcRenderer.invoke('list-providers'),
  createProfileWindow: (providerId?: string) => ipcRenderer.invoke('create-profile-window', { providerId }),
  openProfileWindow: (profileId: string) => ipcRenderer.invoke('open-profile-window', { profileId }),
  deleteProfileWindow: (profileId: string) => ipcRenderer.invoke('delete-profile', { profileId }),
  setProfileAutoOpen: (profileId: string, autoOpen: boolean) => ipcRenderer.invoke('set-profile-auto-open', { profileId, autoOpen }),
  // ========== 快捷提示词 ==========
  listSnippets: () => ipcRenderer.invoke('list-snippets'),
  saveSnippets: (snippets: any) => ipcRenderer.invoke('save-snippets', { snippets }),
  triggerSnippet: (content: string, autoSend: boolean) => ipcRenderer.invoke('trigger-snippet', { content, autoSend }),
  onSnippetsChanged: (cb: () => void) => {
    ipcRenderer.on('shell-snippets-changed', () => cb());
  },
  // ========== 设置 ==========
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data: any) => ipcRenderer.invoke('save-settings', { data }),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
};

try {
  contextBridge.exposeInMainWorld('shellAPI', shellAPI);
} catch (err) {
  console.error('[Cuckoo Shell] contextBridge 失败:', err);
}
(window as any).shellAPI = shellAPI;
