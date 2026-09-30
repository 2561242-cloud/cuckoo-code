/**
 * 网页内技能快捷栏（可折叠，随 overlay 永久注入）
 *
 * 从主进程拉取已启用的「应用级技能」，在 AI 网页左下角渲染一个可折叠的快捷栏。
 * 点击某个技能 → 通过 IPC 把「请使用 xxx 技能」填入当前对话输入框（只填不发）。
 *
 * 设计：
 *  - 拉取失败 / 无技能时，整个技能栏保持隐藏（不干扰页面）
 *  - 折叠状态记忆在 localStorage，避免每次刷新都展开
 */

interface SkillItem {
  id: string;
  name: string;
  triggers?: string[];
}

const STORAGE_KEY = 'cuckoo-skill-bar-expanded';

/** 取 preload 暴露的 electronAPI（可能不存在，做兜底） */
function getAPI(): any {
  return (window as any).electronAPI || null;
}

/** 转义 HTML，防止技能名注入 */
function esc(s: any): string {
  const div = document.createElement('div');
  div.textContent = String(s == null ? '' : s);
  return div.innerHTML;
}

/** 渲染技能列表 */
function renderList(items: SkillItem[]): void {
  const list = document.getElementById('cuckoo-skill-bar-list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="cuckoo-skill-bar-empty">暂无已启用技能</div>';
    return;
  }
  list.innerHTML = items.map((s) =>
    '<button class="cuckoo-skill-bar-item" data-name="' + esc(s.name) + '">' + esc(s.name) + '</button>'
  ).join('');
  list.querySelectorAll('.cuckoo-skill-bar-item').forEach((el) => {
    el.addEventListener('click', () => {
      const name = (el as any).dataset.name;
      const api = getAPI();
      if (api && api.triggerSkill) {
        api.triggerSkill('请使用 ' + name + ' 技能');
      }
      // 点击后自动收起，避免遮挡
      const bar = document.getElementById('cuckoo-skill-bar');
      if (bar) bar.classList.remove('cuckoo-expanded');
      try { localStorage.setItem(STORAGE_KEY, '0'); } catch (_) {}
    });
  });
}

/** 应用折叠/展开状态 */
function applyExpanded(bar: HTMLElement, expanded: boolean): void {
  bar.classList.toggle('cuckoo-expanded', expanded);
}

/** 初始化技能快捷栏（幂等） */
async function initSkillBar(): Promise<void> {
  const bar = document.getElementById('cuckoo-skill-bar');
  const toggle = document.getElementById('cuckoo-skill-bar-toggle');
  if (!bar || !toggle) return;

  // 折叠状态
  let expanded = false;
  try { expanded = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}
  applyExpanded(bar, expanded);

  toggle.addEventListener('click', () => {
    expanded = !bar.classList.contains('cuckoo-expanded');
    applyExpanded(bar, expanded);
    try { localStorage.setItem(STORAGE_KEY, expanded ? '1' : '0'); } catch (_) {}
  });

  // 拉取已启用技能
  const api = getAPI();
  if (!api || !api.getSkills) return; // 无桥接能力则保持隐藏
  try {
    const res = await api.getSkills();
    const items: SkillItem[] = (res && res.success && Array.isArray(res.skills)) ? res.skills : [];
    if (!items.length) return; // 无技能 → 保持隐藏
    renderList(items);
    bar.classList.remove('cuckoo-hidden');
  } catch (_) {
    // 拉取失败 → 保持隐藏，不打扰
  }
}

export { initSkillBar };
