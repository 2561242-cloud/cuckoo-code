/**
 * 纯净对话模式（Harness）IPC
 *
 * 数据流：
 *   用户输入(harness 页面) → 'harness-send' → 转发给 AI 页面(bridge) 由 sendToChat 发出
 *   AI 回复/工具事件(AI 页面 bridge) → 'harness-event-report' → 转发给 harness 页面显示
 *   切换：'harness-exit' → 隐藏 harness view，露出网页
 *
 * 依赖：仅 window.js（窗口上下文）。与官方 IPC 解耦，独立注册。
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { scanSkills } from '../../skills/index.js';
import { registry } from '../../tools/index.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

/**
 * 注入到 AI 页面执行的上传函数（harness 专用，比官方 attachFile 更健壮）。
 * 先找 input[type=file]，找不到则尝试点击上传按钮再等（很多站点输入框是懒创建的）。
 * 用函数 toString 注入，避免多行字符串转义问题。
 */
function attachFn(doc: any, win: any, b64: any, fileName: any, mimeType: any, timeoutMs: any, waitMs: any) {
  return (async function () {
    try {
      var bin = win.atob(b64);
      var bytes = new win.Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var file = new win.File([bytes], fileName, { type: mimeType });
      function findInput() { return doc.querySelector('input[type=file]'); }
      var input = findInput();
      if (!input) {
        var keys = ['attach', 'upload', 'paperclip', 'file', 'image', '图片', '文件', '上传', '添加'];
        var cands = doc.querySelectorAll('button, [role=button], [class*=attach], [class*=upload], [class*=file], [class*=plus], [class*=add]');
        for (var ci = 0; ci < cands.length; ci++) {
          var b = cands[ci];
          if (!b || b.offsetWidth === 0) continue;
          var sig = String(b.className || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
          var low = sig.toLowerCase();
          for (var ki = 0; ki < keys.length; ki++) {
            if (low.indexOf(keys[ki].toLowerCase()) !== -1) { b.click(); break; }
          }
          input = findInput();
          if (input) break;
        }
        if (!input) {
          var dl = win.Date.now() + 2500;
          while (win.Date.now() < dl && !input) { await new Promise(function (r) { win.setTimeout(r, 120); }); input = findInput(); }
        }
      }
      if (!input) return { success: false, error: '未找到文件上传输入框（已尝试点击上传按钮）' };
      var dt = new win.DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      // dispatch 后立即判断：文件已写入 input 即视为提交成功（图片缩略图不含文件名，不能只靠文本检测）
      var submitted = false;
      try { input.dispatchEvent(new win.Event('change', { bubbles: true })); submitted = true; } catch (e) { /* ignore */ }
      var hasFiles = false;
      try { hasFiles = !!(input.files && input.files.length > 0); } catch (e) { /* ignore */ }
      // 站点可能在 change 后清空 input.files，但文件其实已被接收；派发成功即视为提交成功
      if (submitted) return { success: true, fileName: fileName };
      function fileVisible() {
        var node = input;
        for (var d = 0; d < 12 && node; d++) {
          if (node.innerText && node.innerText.indexOf(fileName) !== -1) return true;
          node = node.parentElement;
        }
        var bt = doc.body ? doc.body.innerText : '';
        return bt.indexOf(fileName) !== -1;
      }
      if (submitted && hasFiles) return { success: true, fileName: fileName };
      // 退化检测：等待附件 chip 出现
      await new Promise(function (r) { win.setTimeout(r, waitMs); });
      if (fileVisible()) return { success: true, fileName: fileName };
      var deadline = win.Date.now() + timeoutMs;
      while (win.Date.now() < deadline) {
        await new Promise(function (r) { win.setTimeout(r, 300); });
        if (fileVisible()) return { success: true, fileName: fileName };
      }
      return { success: false, error: '上传超时，未检测到附件出现' };
    } catch (err: any) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  })();
}

/** 该窗口的 harness view（用于状态查询） */
function getHarnessView(sender: any): any {
  const ctx = windowState.getContextByWebContents(sender);
  return ctx ? (ctx as any).harnessView : null;
}

/**
 * 按 sender 找到对应窗口上下文（含 AI view）。
 * 注意：harness view 不在官方 getContextByWebContents 的匹配范围内，故自行遍历上下文。
 */
function findContext(sender: any): any {
  for (const ctx of windowState.getAllContexts()) {
    const c: any = ctx;
    if (c.harnessView && c.harnessView.webContents === sender) return c;
    if (c.view && c.view.webContents === sender) return c;
    if (c.win && c.win.webContents === sender) return c;
  }
  return null;
}

function registerHarnessIpc(): void {
  // 用户在 harness 输入 → 转给 AI 页面（bridge 会调 sendToChat）
  ipcMain.handle('harness-send', (event: any, payload: any) => {
    console.log('[Cuckoo Harness] 收到用户消息，长度=' + ((payload && payload.text) || '').length);
    const text = (payload && payload.text) || '';
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      return { success: false, error: 'no-ai-view' };
    }
    ctx.view.webContents.send('harness-user-message', { text: text });
    return { success: true };
  });

  // AI 页面的 bridge 上报事件 → 转给 harness 页面
  ipcMain.handle('harness-event-report', (event: any, payload: any) => {
    const ctx = findContext(event.sender);
    if (!ctx) return { success: false };
    const hv = (ctx as any).harnessView;
    if (hv && !hv.webContents.isDestroyed()) {
      hv.webContents.send('harness-event', payload);
    }
    return { success: true };
  });

  // 停止生成：向 AI 页面注入脚本，查找停止按钮并点击（兜底发送 Escape）
  ipcMain.handle('harness-stop', async (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) return { success: false };
    try {
      const code = '(' + attachStopFn.toString() + ')(document, window)';
      const r = await ctx.view.webContents.executeJavaScript(code);
      console.log('[Cuckoo Harness] harness-stop 结果: ' + JSON.stringify(r));
      return { success: !!(r && r.clicked), result: r };
    } catch (err: any) {
      console.log('[Cuckoo Harness] harness-stop 异常: ' + err.message);
      return { success: false, error: err.message };
    }
  });

  // 列出可用技能与工具
  ipcMain.handle('harness-list-tools', async (event: any) => {
    try {
      const ctx = findContext(event.sender);
      const projectDir = ctx && ctx.sessionStore ? ctx.sessionStore.state.selectedProjectDir : null;
      const skills = scanSkills(projectDir || null).map((s: any) => ({ name: s.name, description: s.description }));
      const tools = registry.getDescriptions().map((t: any) => ({ name: t.name, description: t.description }));
      return { success: true, skills, tools };
    } catch (err: any) {
      return { success: false, error: err.message, skills: [], tools: [] };
    }
  });

  // 上传附件
  ipcMain.handle('harness-attach', async (event: any, payload: any) => {
    const files = (payload && payload.files) || [];
    console.log('[Cuckoo Harness] harness-attach 调用, files=' + (Array.isArray(files) ? files.length : 'non-array'));
    if (!Array.isArray(files) || files.length === 0) return { success: false, error: 'empty' };
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.view || ctx.view.webContents.isDestroyed()) {
      return { success: false, error: 'no-ai-view' };
    }
    const pageWc = ctx.view.webContents;
    const results: any[] = [];
    for (const f of files) {
      console.log('[Cuckoo Harness] 上传文件: ' + f.name + ' b64len=' + ((f.data || '').length));
      try {
        const code = '(' + attachFn.toString() + ')(document, window, ' +
          JSON.stringify(f.data || '') + ', ' +
          JSON.stringify(f.name || 'file') + ', ' +
          JSON.stringify(f.mime || 'application/octet-stream') + ', 12000, 500)';
        const r = await pageWc.executeJavaScript(code, true);
        console.log('[Cuckoo Harness] 上传结果: ' + JSON.stringify(r));
        if (r && r.success) results.push({ success: true, name: f.name });
        else results.push({ success: false, name: f.name, error: (r && r.error) || '上传失败' });
      } catch (err: any) {
        console.log('[Cuckoo Harness] 上传异常: ' + err.message);
        results.push({ success: false, name: f.name, error: err.message });
      }
    }
    const ok = results.filter((x) => x.success).length;
    console.log('[Cuckoo Harness] harness-attach 完成, ok=' + ok + '/' + files.length);
    return { success: ok > 0, uploaded: ok, total: files.length, results };
  });

  // 重载 harness 页面（加载最新 HTML，无需重启应用）
  ipcMain.handle('harness-reload', (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !(ctx as any).harnessView || (ctx as any).harnessView.webContents.isDestroyed()) {
      return { success: false };
    }
    try {
      (ctx as any).harnessView.webContents.reloadIgnoringCache();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 退出纯净模式，返回网页模式
  ipcMain.handle('harness-exit', (event: any) => {
    const ctx = findContext(event.sender);
    if (!ctx || !ctx.win) return { success: false };
    try { (ctx.win as any).__ckToggleHarness?.(false); } catch (_) {}
    return { success: true };
  });

  // harness 页面就绪
  ipcMain.on('harness-ready', () => {
    console.log('[Cuckoo Harness] 页面已就绪');
  });
}

/**
 * 停止生成：多策略查找 AI 页面的"停止"按钮并点击（注入 AI 页面执行）。
 * 返回诊断信息：{ clicked, reason, candidates }，便于主进程日志排查。
 */
function attachStopFn(doc: any, win: any) {
  try {
    var vh = win.innerHeight || 800;
    var kw = /(停止|停止生成|stop|cancel|abort|结束|中断)/i;
    var cands = doc.querySelectorAll('button, [role="button"]');
    var scored = [];
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (!el) continue;
      var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      var isBtn = (el.tagName === 'BUTTON');
      var cls = (typeof el.className === 'string') ? el.className : '';
      var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      var title = (el.getAttribute && el.getAttribute('title')) || '';
      var txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16);
      var sig = cls + ' ' + aria + ' ' + title + ' ' + txt;
      var lower = sig.toLowerCase();
      var score = 0;
      // 真按钮优先（div 包装点不动）
      if (isBtn) score += 8;
      if (kw.test(sig)) score += 10;
      if (/stop|abort|cancel|停止|中止|中断/.test(lower)) score += 6;
      if (/stop-|--stop|btn-stop|stop-btn|stopbtn/.test(lower)) score += 5;
      // 停止图标通常是方块 rect（svg 内 rect），发送图标是箭头 path
      var hasRect = false;
      try { hasRect = !!(el.querySelector && el.querySelector('svg rect')); } catch (e) { /* ignore */ }
      if (hasRect) score += 5;
      // 位于视口下方（输入区附近）
      if (rect.top > vh * 0.4) score += 3;
      if (score > 0) scored.push({ el: el, score: score, sig: sig.slice(0, 80), isBtn: isBtn, hasRect: hasRect });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    var diag = scored.slice(0, 6).map(function (s) { return s.score + ':' + s.sig; });
    // 优先选"按钮 + 有方块图标"的候选
    var pick = null;
    for (var k = 0; k < scored.length; k++) {
      if (scored[k].isBtn && scored[k].hasRect) { pick = scored[k]; break; }
    }
    if (!pick && scored.length > 0) pick = scored[0];
    if (pick) {
      try { pick.el.click(); } catch (e) { /* ignore */ }
      return { clicked: true, reason: 'scored', candidates: diag };
    }
    // 兜底：Escape
    try { doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) { /* ignore */ }
    return { clicked: false, reason: 'no-button', candidates: diag };
  } catch (e: any) {
    return { clicked: false, reason: 'error:' + (e && e.message) };
  }
}

export { registerHarnessIpc };
