'use strict';
/**
 * mcp/config 测试（新：项目级 + 用户级双路径）
 * electron 的 app.getPath 是外部边界，mock 它指向临时目录（符合"只 mock 外部边界"原则）。
 * os.homedir 也 mock，避免污染真实用户目录。
 */
import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'cuckoo-mcp-config-test');
const FAKE_HOME = path.join(TMP, 'home');
const USER_DATA = path.join(TMP, 'userdata');
const PROJ1 = path.join(TMP, 'proj1');
const PROJ2 = path.join(TMP, 'proj2');

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => (id) => {
      if (id === 'electron') return { app: { getPath: () => USER_DATA } };
      throw new Error('unexpected require: ' + id);
    },
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, homedir: () => FAKE_HOME } };
});

let cfg;

function userConfigFile() { return path.join(FAKE_HOME, '.cuckoo', 'mcp.json'); }
function projConfigFile(p) { return path.join(p, '.cuckoo', 'mcp.json'); }

beforeEach(async () => {
  vi.resetModules();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(PROJ1, { recursive: true });
  fs.mkdirSync(PROJ2, { recursive: true });
  cfg = await import('../../src/mcp/config.js');
});

test('无任何配置时 getServers 为空', () => {
  assert.deepStrictEqual(cfg.getServers(null), []);
});

test('upsertServer 写入用户级配置（stdio）', () => {
  cfg.upsertServer({ name: 'fs', type: 'stdio', command: 'npx', args: ['-y', 'server'] });
  const raw = JSON.parse(fs.readFileSync(userConfigFile(), 'utf-8'));
  assert.strictEqual(raw.mcpServers.fs.command, 'npx');
  assert.deepStrictEqual(raw.mcpServers.fs.args, ['-y', 'server']);
});

test('upsertServer 写入 http 配置（带 url/headers）', () => {
  cfg.upsertServer({ name: 'db', type: 'http', url: 'https://x', headers: { a: '1' } });
  const raw = JSON.parse(fs.readFileSync(userConfigFile(), 'utf-8'));
  assert.strictEqual(raw.mcpServers.db.url, 'https://x');
  assert.deepStrictEqual(raw.mcpServers.db.headers, { a: '1' });
  assert.strictEqual(raw.mcpServers.db.command, undefined);
});

test('getServers 默认启用，type 由 url 决定', () => {
  cfg.upsertServer({ name: 'fs', type: 'stdio', command: 'npx' });
  cfg.upsertServer({ name: 'db', type: 'http', url: 'https://x' });
  const list = cfg.getServers(PROJ1);
  const fsS = list.find(s => s.name === 'fs');
  const dbS = list.find(s => s.name === 'db');
  assert.strictEqual(fsS.type, 'stdio');
  assert.strictEqual(fsS.enabled, true, '默认启用');
  assert.strictEqual(dbS.type, 'http');
});

test('setServerEnabled(false) 后 getEnabledServers 不含它', () => {
  cfg.upsertServer({ name: 'fs', type: 'stdio', command: 'npx' });
  cfg.setServerEnabled('fs', false, null);
  assert.strictEqual(cfg.getServers(null).find(s => s.name === 'fs').enabled, false);
  assert.strictEqual(cfg.getEnabledServers(null).length, 0);
});

test('removeServer 同时清配置与状态', () => {
  cfg.upsertServer({ name: 'fs', type: 'stdio', command: 'npx' });
  cfg.setServerEnabled('fs', false, null);
  cfg.removeServer('fs');
  assert.strictEqual(cfg.getServers(null).length, 0);
  const raw = JSON.parse(fs.readFileSync(userConfigFile(), 'utf-8'));
  assert.strictEqual(raw.mcpServers.fs, undefined);
});

test('upsertServer 覆盖同名 server', () => {
  cfg.upsertServer({ name: 'fs', type: 'stdio', command: 'a' });
  cfg.upsertServer({ name: 'fs', type: 'stdio', command: 'b' });
  const raw = JSON.parse(fs.readFileSync(userConfigFile(), 'utf-8'));
  assert.strictEqual(raw.mcpServers.fs.command, 'b');
  assert.strictEqual(cfg.getServers(null).length, 1);
});

// ========== 新功能：项目级 + 用户级 ==========

test('项目级覆盖用户级同名 server', () => {
  // 用户级：fs -> command=user
  cfg.upsertServer({ name: 'fs', type: 'stdio', command: 'user-cmd' });
  // 项目级：fs -> command=proj（手动写文件）
  fs.mkdirSync(path.join(PROJ1, '.cuckoo'), { recursive: true });
  fs.writeFileSync(projConfigFile(PROJ1), JSON.stringify({
    mcpServers: { fs: { command: 'proj-cmd' } }
  }));
  const list = cfg.getServers(PROJ1);
  const fsS = list.find(s => s.name === 'fs');
  assert.strictEqual(fsS.command, 'proj-cmd', '项目级优先');
  assert.strictEqual(fsS.source, 'project');
});

test('不同项目读到不同的项目级配置', () => {
  fs.mkdirSync(path.join(PROJ1, '.cuckoo'), { recursive: true });
  fs.writeFileSync(projConfigFile(PROJ1), JSON.stringify({ mcpServers: { onlyP1: { command: 'x' } } }));
  assert.strictEqual(cfg.getServers(PROJ1).length, 1);
  assert.strictEqual(cfg.getServers(PROJ2).length, 0);
});

test('用户级 server 在所有项目都可见', () => {
  cfg.upsertServer({ name: 'global', type: 'stdio', command: 'g' });
  assert.strictEqual(cfg.getServers(PROJ1).find(s => s.name === 'global').source, 'user');
  assert.strictEqual(cfg.getServers(PROJ2).find(s => s.name === 'global').source, 'user');
});

test('项目级 server 的状态存项目级（不污染用户级）', () => {
  fs.mkdirSync(path.join(PROJ1, '.cuckoo'), { recursive: true });
  fs.writeFileSync(projConfigFile(PROJ1), JSON.stringify({ mcpServers: { p: { command: 'x' } } }));
  cfg.setServerEnabled('p', false, PROJ1);
  // 项目级状态文件应记录
  const st = JSON.parse(fs.readFileSync(path.join(PROJ1, '.cuckoo', 'mcp-state.json'), 'utf-8'));
  assert.strictEqual(st.p, false);
  // 用户级状态文件不应有
  const ustateFile = path.join(FAKE_HOME, '.cuckoo', 'mcp-state.json');
  if (fs.existsSync(ustateFile)) {
    const ustate = JSON.parse(fs.readFileSync(ustateFile, 'utf-8'));
    assert.strictEqual(ustate.p, undefined);
  }
});

// ========== 首次迁移 ==========

test('migrateLegacy：新位置无文件时，把旧 userData/mcp.json 复制过去', () => {
  fs.writeFileSync(path.join(USER_DATA, 'mcp.json'), JSON.stringify({
    mcpServers: { legacy: { command: 'old' } }
  }));
  cfg.migrateLegacy();
  const raw = JSON.parse(fs.readFileSync(userConfigFile(), 'utf-8'));
  assert.strictEqual(raw.mcpServers.legacy.command, 'old');
  // 旧文件保留
  assert.ok(fs.existsSync(path.join(USER_DATA, 'mcp.json')), '旧文件应保留');
});

test('migrateLegacy：新位置已有文件时不动', () => {
  cfg.upsertServer({ name: 'newone', type: 'stdio', command: 'new' });
  fs.writeFileSync(path.join(USER_DATA, 'mcp.json'), JSON.stringify({
    mcpServers: { legacy: { command: 'old' } }
  }));
  cfg.migrateLegacy();
  const raw = JSON.parse(fs.readFileSync(userConfigFile(), 'utf-8'));
  assert.strictEqual(raw.mcpServers.newone.command, 'new');
  assert.strictEqual(raw.mcpServers.legacy, undefined, '不应被旧文件覆盖');
});

test('migrateLegacy：旧文件非法 JSON 时不动', () => {
  fs.writeFileSync(path.join(USER_DATA, 'mcp.json'), 'not json {{{');
  cfg.migrateLegacy();
  assert.ok(!fs.existsSync(userConfigFile()), '不应创建新文件');
});
