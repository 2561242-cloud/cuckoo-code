/**
 * ChatGPT 网络拦截器（注入 AI 网页主世界执行）
 *
 * 构建期经 esbuild 打包为自包含 IIFE（见 scripts/build-hooks.mjs）。
 * 共享 SSE 帧解码见 ./shared/sse.js；本平台需处理 [DONE] 与 patch 操作，故 parseBlock 本地定义。
 */
import { createFrameDecoder, extractData } from './shared/sse.js';

function install(): void {
  var MARKER = '__cuckooChatgptHookInstalled__';
  if (window[MARKER]) return;
  window[MARKER] = true;

  function isCompletion(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      var u = new URL(url, document.baseURI);
      var host = u.hostname;
      if (host.indexOf('chatgpt.com') === -1 && host.indexOf('chat.openai.com') === -1) return false;
      return /\/backend-api\/(?:f\/)?conversation\/?$/.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function dispatch(text, finished) {
    try {
      window.dispatchEvent(new CustomEvent('cuckoo-ai-response', {
        detail: { text: text || '', finished: !!finished }
      }));
    } catch (e) { /* ignore */ }
  }

  // 流式增量事件（纯新增，供纯净模式实时渲染；节流 ~80ms）
  var lastStreamAt = 0;
  function dispatchStream(text, finished) {
    var now = Date.now();
    if (!finished && now - lastStreamAt < 80) return;
    lastStreamAt = now;
    try {
      window.dispatchEvent(new CustomEvent('cuckoo-ai-stream', {
        detail: { think: '', text: text || '', finished: !!finished }
      }));
    } catch (e) { /* ignore */ }
  }

  // 返回 { data: string|null, done: boolean }
  function parseBlock(block) {
    var data = extractData(block);
    if (data == null) return { data: null, done: false };
    if (data === '[DONE]') return { data: null, done: true };
    return { data: data, done: false };
  }

  // ---------- 回复文本提取 ----------
  function createExtractor() {
    var text = '';
    var finished = false;

    function extractParts(content) {
      if (!content || !Array.isArray(content.parts)) return null;
      var out = '';
      for (var i = 0; i < content.parts.length; i++) {
        var p = content.parts[i];
        if (typeof p === 'string') out += p;
        else if (p && typeof p === 'object' && typeof p.text === 'string') out += p.text;
      }
      return out;
    }

    function applyOp(node) {
      if (!node || typeof node !== 'object') return;

      // 1) 批量操作：o='patch' / 'BATCH'，v 为操作数组
      if (Array.isArray(node.v) && (node.o === 'patch' || node.o === 'BATCH')) {
        for (var i = 0; i < node.v.length; i++) applyOp(node.v[i]);
        return;
      }

      // 2) 消息快照：v.message（仅采纳 assistant）
      if (node.v && typeof node.v === 'object' && node.v.message) {
        var m = node.v.message;
        var role = m.author && m.author.role;
        if (role === 'assistant') {
          var snap = extractParts(m.content);
          if (snap !== null) text = snap;
        }
        return;
      }

      // 3) 路径操作
      if (typeof node.p === 'string' && node.p !== '') {
        if (node.p === '/message/status' && node.v === 'finished_successfully') { finished = true; return; }
        if (node.p === '/message/end_turn' && node.v === true) { finished = true; return; }
        if (/\/message\/content\/parts\/\d+$/.test(node.p)) {
          if (typeof node.v === 'string') {
            if (node.o === 'append' || node.o === 'add') text += node.v;
            else text = node.v;
          }
        }
        return;
      }

      // 4) 裸 v 字符串（无有效 p）：追加正文
      if (typeof node.v === 'string') { text += node.v; return; }

      // 5) 类型化结束事件
      if (node.type === 'message_stream_complete' || node.type === 'message_stream_completed') {
        finished = true;
      }
    }

    return {
      consume: function (parsed) { applyOp(parsed); },
      markDone: function () { finished = true; },
      get text() { return text; },
      get finished() { return finished; }
    };
  }

  function observeBody(body) {
    if (!body) return;
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function flushFrame(frame) {
      var r = parseBlock(frame);
      if (r.done) { extractor.markDone(); return; }
      if (r.data == null) return;
      var parsed;
      try { parsed = JSON.parse(r.data); } catch (e) { return; }
      extractor.consume(parsed);
    }

    function feed(chunk) {
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) flushFrame(frames[i]);
      dispatchStream(extractor.text, extractor.finished);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true);
      }
    }

    function pump() {
      reader.read().then(function (r) {
        if (r.done) {
          var tail = decoder.decode();
          if (tail) feed(tail);
          var rest = frameDecoder.finish();
          for (var i = 0; i < rest.length; i++) flushFrame(rest[i]);
          if (!dispatched) { dispatched = true; dispatch(extractor.text, true); }
          return;
        }
        feed(decoder.decode(r.value, { stream: true }));
        pump();
      }).catch(function () {
        if (!dispatched) { dispatched = true; dispatch(extractor.text, true); }
      });
    }
    pump();
  }

  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input: any, init: any) {
      var url = typeof input === 'string' ? input
        : (input && input.url) ? input.url
        : (input && input.href) ? input.href : '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var p = origFetch.apply(this, arguments);
      if (!isCompletion(url, method)) return p;
      return p.then(function (response) {
        try {
          if (response && response.body) observeBody(response.clone().body);
        } catch (e) { /* ignore */ }
        return response;
      });
    };
  }

  // ---------- XHR 拦截 ----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrInfo.set(this, { url: url, method: method }); } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var info = xhrInfo.get(this);
    if (info && isCompletion(info.url, info.method)) {
      try { observeXhr(this); } catch (e) { /* ignore */ }
    }
    return origSend.apply(this, arguments);
  };

  function observeXhr(xhr) {
    var lastLen = 0;
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function flushFrame(frame) {
      var r = parseBlock(frame);
      if (r.done) { extractor.markDone(); return; }
      if (r.data == null) return;
      var parsed;
      try { parsed = JSON.parse(r.data); } catch (e) { return; }
      extractor.consume(parsed);
    }

    function consumeChunk() {
      var raw;
      try { raw = xhr.responseText; } catch (e) { return; }
      if (typeof raw !== 'string' || raw.length <= lastLen) return;
      var chunk = raw.slice(lastLen);
      lastLen = raw.length;
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) flushFrame(frames[i]);
      dispatchStream(extractor.text, extractor.finished);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true);
      }
    }

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) consumeChunk();
      if (xhr.readyState === 4 && !dispatched) {
        var rest = frameDecoder.finish();
        for (var i = 0; i < rest.length; i++) flushFrame(rest[i]);
        dispatched = true;
        dispatch(extractor.text, true);
      }
    });
  }
}

install();

export { install };
