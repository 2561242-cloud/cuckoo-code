/**
 * 规则扫描：项目级 + 用户级目录 → RuleMeta[]
 *
 * 目录约定（对齐 Claude Code）：
 *  - 项目级：`<projectDir>/.cuckoo/rules/*.md`
 *  - 用户级：`~/.cuckoo/rules/*.md`
 *
 * 规则：
 *  - 只扫 rules 目录的直接子目录（一层）
 *  - 同名规则不覆盖（用户级 + 项目级都保留，靠路径区分）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseRuleFrontmatter } from './frontmatter.js';
import type { RuleMeta, RuleSource } from './types.js';

/** 用户级目录（可用 CUCKOO_HOME 覆盖，供测试隔离） */
function getUserRulesDir(): string {
  const base = process.env.CUCKOO_HOME || path.join(os.homedir(), '.cuckoo');
  return path.join(base, 'rules');
}

function scanDir(rulesDir: string, source: RuleSource): RuleMeta[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rulesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: RuleMeta[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
    const rulePath = path.join(rulesDir, ent.name);
    let raw: string;
    try {
      raw = fs.readFileSync(rulePath, 'utf-8');
    } catch {
      continue;
    }
    const { name, paths, body } = parseRuleFrontmatter(raw);
    const finalName = name || ent.name.replace(/\.md$/i, '');
    if (!finalName.trim() || !body.trim()) continue; // 无名或无正文，跳过
    result.push({ name: finalName, paths, rulePath, body: body.trim(), source });
  }
  return result;
}

/**
 * 扫描并合并规则（项目级 + 用户级都保留，同名不覆盖）。
 * @param projectDir 项目根（可为 null）
 */
export function scanRules(projectDir: string | null): RuleMeta[] {
  const user = scanDir(getUserRulesDir(), 'user');
  const project = projectDir ? scanDir(path.join(projectDir, '.cuckoo', 'rules'), 'project') : [];
  // 项目级在前（展示顺序），同名不去重
  return [...project, ...user];
}

/** 只取"无 paths"的规则（初始化时注入） */
export function getUnscopedRules(rules: RuleMeta[]): RuleMeta[] {
  return rules.filter((r) => r.paths.length === 0);
}

/** 只取"有 paths"的规则（read 匹配时注入） */
export function getScopedRules(rules: RuleMeta[]): RuleMeta[] {
  return rules.filter((r) => r.paths.length > 0);
}
