'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import { OVERLAY_HTML, OVERLAY_CSS } from '../../src/overlay/template.generated.js';

test('OVERLAY_HTML 包含核心元素', () => {
  assert.ok(OVERLAY_HTML.includes('cuckoo-overlay'));
  assert.ok(OVERLAY_HTML.includes('cuckoo-btn-init'));
  assert.ok(OVERLAY_HTML.includes('cuckoo-session-list'));
  assert.ok(OVERLAY_HTML.includes('cuckoo-btn-manual-parse'));
  assert.ok(OVERLAY_HTML.includes('cuckoo-status-badge'));
});

test('OVERLAY_HTML 包含工具调用遮罩及提示文案', () => {
  assert.ok(OVERLAY_HTML.includes('id="cuckoo-tool-mask"'));
  assert.ok(OVERLAY_HTML.includes('正在执行工具调用，请稍候'));
});

test('OVERLAY_CSS 包含核心样式', () => {
  assert.ok(OVERLAY_CSS.includes('.cuckoo-overlay'));
  assert.ok(OVERLAY_CSS.includes('--ck-primary'));
  assert.ok(OVERLAY_CSS.includes('cuckoo-hidden'));
});

test('OVERLAY_CSS 包含工具调用遮罩样式', () => {
  assert.ok(OVERLAY_CSS.includes('.cuckoo-tool-mask'));
  assert.ok(OVERLAY_CSS.includes('.cuckoo-tool-mask-spinner'));
});

