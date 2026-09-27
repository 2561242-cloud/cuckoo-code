/**
 * MCP 配置管理（项目级 + 用户级）
 *
 * 配置格式：Claude Desktop 兼容（可直接分享/导入）
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": [...] },   // stdio
 *     "remote-db":  { "url": "https://..." }                // http
 *   }
 * }
 *
 * 路径：
 *  - 项目级：<projectDir>/.cuckoo/mcp.json
 *  - 用户级：~/.cuckoo/mcp.json
 * 同名 server 项目级覆盖用户级。
 *
 * 启用状态单独存（不污染主流格式）：
 *  - 项目级：<projectDir>/.cuckoo/mcp-state.json
 *  - 用户级：~/.cuckoo/mcp-state.json
 *
 * 首次迁移：~/.cuckoo/mcp.json 不存在时，把旧 userData/mcp.json 复制过去（旧文件保留不动）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');

// ========== 路径 ==========

/**
 * 用户级目录。默认 ~/.cuckoo；可用环境变量 CUCKOO_HOME 覆盖（测试隔离 / 用户自定义）。
 */
function getUserDir(): string {
  const override = process.env.CUCKOO_HOME;
  return override ? override : path.join(os.homedir(), '.cuckoo');
}
function getUserConfigFile(): string {
  return path.join(getUserDir(), 'mcp.json');
}
function getUserStateFile(): string {
  return path.join(getUserDir(), 'mcp-state.json');
}
function getProjectConfigFile(projectDir: string): string {
  return path.join(projectDir, '.cuckoo', 'mcp.json');
}
function getProjectStateFile(projectDir: string): string {
  return path.join(projectDir, '.cuckoo', 'mcp-state.json');
}

// 兼容旧导出名（entry.ts 用于显示路径）
function getConfigFile(): string {
  return getUserConfigFile();
}
function getStateFile(): string {
  return getUserStateFile();
}

// ========== 读写工具 ==========

function readJson(file: string): any {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err: any) {
    console.error('[MCP] 读取失败:', file, err.message);
  }
  return null;
}

function writeJson(file: string, data: any): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[MCP] 已写入:', file);
    return true;
  } catch (err: any) {
    console.error('[MCP] 写入失败:', file, err.message);
    return false;
  }
}

// ========== 首次迁移 ==========

/**
 * 启动时调用一次：
 * 1. ~/.cuckoo/mcp.json 已存在 → 什么都不做
 * 2. 不存在 → 若 userData/mcp.json 存在且是合法 JSON → 复制到 ~/.cuckoo/mcp.json
 * 3. 旧文件保留原样（不删、不改名）
 */
function migrateLegacy(): void {
  const newFile = getUserConfigFile();
  if (fs.existsSync(newFile)) return; // 新位置已有，不动

  let legacyFile: string;
  try {
    legacyFile = path.join(app.getPath('userData'), 'mcp.json');
  } catch (_) {
    return;
  }
  if (!fs.existsSync(legacyFile)) return;

  const data = readJson(legacyFile);
  if (!data || typeof data !== 'object' || !data.mcpServers) {
    console.warn('[MCP] 旧配置存在但非合法 MCP 格式，跳过迁移:', legacyFile);
    return;
  }
  if (writeJson(newFile, data)) {
    console.log('[MCP] 已把旧配置迁移到:', newFile, '（旧文件保留）');
  }
}

// ========== 读取（合并两级）==========

/** 读某层的 servers 原始对象 */
function readServersAt(configFile: string): Record<string, any> {
  const cfg = readJson(configFile);
  if (cfg && typeof cfg.mcpServers === 'object' && cfg.mcpServers) {
    return cfg.mcpServers;
  }
  return {};
}

/** 读某层的状态 */
function readStateAt(stateFile: string): Record<string, boolean> {
  const st = readJson(stateFile);
  return (st && typeof st === 'object') ? st : {};
}

/**
 * 合并后的 server 列表（带 name / type / enabled / source）。
 * 项目级覆盖用户级（同名时用项目级的定义和状态）。
 */
function getServers(projectDir: string | null): any[] {
  const userServers = readServersAt(getUserConfigFile());
  const userState = readStateAt(getUserStateFile());
  const projectServers = projectDir ? readServersAt(getProjectConfigFile(projectDir)) : {};
  const projectState = projectDir ? readStateAt(getProjectStateFile(projectDir)) : {};

  const out: any[] = [];
  const seen = new Set<string>();

  // 先项目级（优先）
  for (const [name, def] of Object.entries(projectServers) as [string, any][]) {
    seen.add(name);
    out.push(buildServerDef(name, def, 'project', projectState));
  }
  // 再用户级（跳过项目级已有的同名）
  for (const [name, def] of Object.entries(userServers) as [string, any][]) {
    if (seen.has(name)) continue;
    out.push(buildServerDef(name, def, 'user', userState));
  }
  return out;
}

function buildServerDef(name: string, def: any, source: string, state: Record<string, boolean>): any {
  return {
    name,
    source, // 'project' | 'user'
    type: def && def.url ? 'http' : 'stdio',
    command: def && def.command,
    args: (def && def.args) || [],
    url: def && def.url,
    headers: def && def.headers,
    env: def && def.env,
    cwd: def && def.cwd,
    enabled: state[name] !== false, // 默认启用
  };
}

function getEnabledServers(projectDir: string | null): any[] {
  return getServers(projectDir).filter(s => s.enabled);
}

// ========== 写入（固定用户级）==========

function upsertServer(server: any): any {
  const file = getUserConfigFile();
  const cfg = readJson(file) || {};
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') {
    cfg.mcpServers = {};
  }
  const def: any = {};
  if (server.type === 'http') {
    if (server.url) def.url = server.url;
    if (server.headers) def.headers = server.headers;
  } else {
    if (server.command) def.command = server.command;
    if (server.args && server.args.length) def.args = server.args;
    if (server.env) def.env = server.env;
    if (server.cwd) def.cwd = server.cwd;
  }
  cfg.mcpServers[server.name] = def;
  writeJson(file, cfg);
  return server;
}

/** 删除 server：从用户级配置删除；项目级同名的由用户手动处理 */
function removeServer(name: string): boolean {
  const file = getUserConfigFile();
  const cfg = readJson(file) || {};
  if (cfg.mcpServers) delete cfg.mcpServers[name];
  writeJson(file, cfg);
  // 用户级状态
  const state = readStateAt(getUserStateFile());
  delete state[name];
  writeJson(getUserStateFile(), state);
  return true;
}

/**
 * 设置启用状态。状态跟着"定义来源"走：
 *  - server 定义在项目级 → 写项目级状态
 *  - server 定义在用户级 → 写用户级状态
 * 若 projectDir 为 null，只能操作用户级。
 */
function setServerEnabled(name: string, enabled: any, projectDir: string | null = null): boolean {
  // 判断定义在哪
  const inProject = projectDir ? !!readServersAt(getProjectConfigFile(projectDir))[name] : false;
  if (inProject) {
    const st = readStateAt(getProjectStateFile(projectDir as string));
    st[name] = !!enabled;
    return writeJson(getProjectStateFile(projectDir as string), st);
  }
  const st = readStateAt(getUserStateFile());
  st[name] = !!enabled;
  return writeJson(getUserStateFile(), st);
}

export {
  getUserConfigFile,
  getUserStateFile,
  getProjectConfigFile,
  getProjectStateFile,
  getConfigFile, // 兼容旧名
  getStateFile,  // 兼容旧名
  migrateLegacy,
  getServers,
  getEnabledServers,
  upsertServer,
  removeServer,
  setServerEnabled,
};
