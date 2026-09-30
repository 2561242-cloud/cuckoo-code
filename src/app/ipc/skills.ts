/**
 * IPC：技能管理 + 技能市场
 *
 * 技能来源三类（见 skills/scanner.ts）：项目级 > 应用级 > 用户级。
 * 本模块提供：
 *  - 应用级技能 CRUD（list-app-skills / upsert-skill / remove-skill / set-skill-enabled）
 *  - 市场（SkillHub）搜索/详情/安装（search-skills / get-skill-detail / install-skill / refresh-skill-names）
 *  - 网页内技能快捷栏数据与点击填充（shell-get-skills / shell-trigger-skill）
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import * as skillConfig from '../../skills/config.js';
import * as skillMarket from '../../skills/market.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/** 取事件来源对应的 AI 页面 view */
function viewOf(event: any): any {
  return windowState.getViewByWebContents(event.sender);
}

function registerSkillsIpc(): void {
  // 列出所有应用级技能（带启用状态）
  ipcMain.handle('list-app-skills', async () => {
    try {
      return { success: true, skills: skillConfig.listSkills() };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 新增或更新技能
  ipcMain.handle('upsert-skill', async (_event: any, { skill }: any) => {
    try {
      const saved = skillConfig.upsertSkill(skill || {});
      return { success: true, skill: saved };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 删除技能
  ipcMain.handle('remove-skill', async (_event: any, { id }: any) => {
    try {
      const ok = skillConfig.removeSkill(id);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 启用/禁用技能
  ipcMain.handle('set-skill-enabled', async (_event: any, { id, enabled }: any) => {
    try {
      const ok = skillConfig.setSkillEnabled(id, !!enabled);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 在线搜索技能（SkillHub 市场）
  ipcMain.handle('search-skills', async (_event: any, { keyword, page, pageSize }: any) => {
    try {
      const result = await skillMarket.searchSkills(keyword || '', page || 1, pageSize || 24);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 获取市场技能详情
  ipcMain.handle('get-skill-detail', async (_event: any, { slug, namespace }: any) => {
    try {
      const detail = await skillMarket.getSkillDetail(slug, namespace);
      return { success: true, detail };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 更新已安装技能的名称：从市场重新拉取中文名
  // 优先用记录的 slug/namespace；老技能没记录时，用技能 id 作为 slug 去市场搜索匹配
  ipcMain.handle('refresh-skill-names', async () => {
    try {
      const skills = skillConfig.listSkills();
      let updated = 0;
      let skipped = 0;
      const failed: string[] = [];
      for (const s of skills) {
        const meta = skillConfig.getSkillMeta(s.id) || {};
        let slug = meta.slug;
        let namespace = meta.namespace;
        // 老技能：用 id 作为关键词去市场搜索匹配
        if (!slug || !namespace) {
          try {
            const kw = String(s.id).replace(/[-_]?skills?$/i, ''); // 去掉 -skill(s) 后缀再搜
            const r = await skillMarket.searchSkills(kw, 1, 15);
            const list = (r.skills || []).filter((x: any) => x.namespace); // 必须有 namespace
            const hasCn = (t: any) => /[\u4e00-\u9fa5]/.test(String(t || ''));
            const idLower = String(s.id).toLowerCase();
            // 匹配优先级：slug 精确 > name 精确 > 去后缀相等；同分优先含中文名
            const exactSlug = list.find((x: any) => String(x.slug).toLowerCase() === idLower);
            const exactName = list.find((x: any) => String(x.name).toLowerCase() === idLower);
            const loose = list.find((x: any) => {
              const sl = String(x.slug).toLowerCase().replace(/[-_]?skills?$/i, '');
              return sl === kw.toLowerCase();
            });
            const pick = exactSlug
              || exactName
              || loose
              || list.find((x: any) => hasCn(x.name));
            if (pick) { slug = pick.slug; namespace = pick.namespace; }
          } catch (_) { /* 忽略，走下面跳过 */ }
        }
        if (!slug || !namespace) { skipped++; failed.push(s.name + '(未匹配)'); continue; }
        try {
          const d = await skillMarket.getSkillDetail(slug, namespace);
          const cn = d && d.name;
          // 只采用含中文的名字；市场名是英文时不覆盖（避免把 SKILL.md 的中文品牌名挡掉）
          if (cn && /[\u4e00-\u9fa5]/.test(cn) && cn !== s.name) {
            skillConfig.setSkillDisplayName(s.id, cn, slug, namespace);
            updated++;
          } else if (!cn || !/[\u4e00-\u9fa5]/.test(cn)) {
            skipped++;
          }
        } catch (_) { skipped++; failed.push(s.name + '(拉取失败)'); }
      }
      return { success: true, updated, skipped, failed, skills: skillConfig.listSkills() };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 从市场下载并安装技能
  ipcMain.handle('install-skill', async (_event: any, { slug, namespace, displayName }: any) => {
    try {
      const dir = await skillMarket.downloadAndExtract(slug, namespace);
      // displayName 传市场的中文名；未传则从市场详情兜底拉取
      let cn = displayName;
      if (!cn && slug && namespace) {
        try { const d = await skillMarket.getSkillDetail(slug, namespace); cn = d && d.name; } catch (_) { /* 忽略 */ }
      }
      // 只采用含中文的名字；英文市场名不覆盖（保留 SKILL.md 里的品牌名）
      if (cn && !/[\u4e00-\u9fa5]/.test(cn)) cn = undefined;
      const saved = skillConfig.installSkillFromDir(dir, undefined, cn, slug, namespace);
      return { success: true, skill: saved };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 查询已启用的应用级技能（网页内快捷栏用）
  ipcMain.handle('shell-get-skills', async () => {
    try {
      const skills = (skillConfig.listSkills() || [])
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
}

export { registerSkillsIpc };
