// SPDX-License-Identifier: GPL-2.0-only
//
// charsiu desktop, the page. Everything that touches the system (the
// charsiu process, HTTP, files, the NPU) is a Rust command; this file only
// draws and keeps the conversation.
'use strict';

const TAURI = window.__TAURI__;
const invoke = TAURI ? TAURI.core.invoke : null;

const $ = (id) => document.getElementById(id);

const INSTALL = {
  windows: 'irm https://raw.githubusercontent.com/gahingwoo/woa-rk3576-npu/main/win/charsiu-install.ps1 | iex',
  windowsUser: '& ([scriptblock]::Create((irm https://raw.githubusercontent.com/gahingwoo/woa-rk3576-npu/main/win/charsiu-install.ps1))) -UserAccess',
  linux: 'curl -fsSL https://raw.githubusercontent.com/gahingwoo/charsiu/stable/scripts/charsiu-install.sh | sh',
  armbian: 'sudo apt install charsiu',
};

const DEFAULTS = {
  temperature: 0,
  maxTokens: 512,
  system: '',
  language: '',
  theme: 'system',
  charsiuPath: '',
  model: '',
};

const S = {
  info: { os: '', version: '', charsiu: '' },
  settings: { ...DEFAULTS },
  convs: [],
  currentId: null,
  backend: { state: 'stopped', npu: 'unknown' },
  npu: null,
  models: null,
  modelsError: '',
  pull: null,
  pullTimer: null,
  generating: false,
  lastStats: null,
  removeArmed: '',
};

// ---- helpers ----------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));
}

function mb(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  return Math.round(bytes / 1048576) + ' MB';
}

function base(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function debounce(fn, ms) {
  let h = null;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

const ICON_X = '<svg class="pf-v6-svg" viewBox="0 0 352 512" fill="currentColor" aria-hidden="true" width="1em" height="1em"><path d="M242.7 256l100.1-100.1c12.3-12.3 12.3-32.2 0-44.5l-22.2-22.2c-12.3-12.3-32.2-12.3-44.5 0L176 189.3 75.9 89.2c-12.3-12.3-32.2-12.3-44.5 0L9.2 111.4c-12.3 12.3-12.3 32.2 0 44.5L109.3 256 9.2 356.1c-12.3 12.3-12.3 32.2 0 44.5l22.2 22.2c12.3 12.3 32.2 12.3 44.5 0L176 322.7l100.1 100.1c12.3 12.3 32.2 12.3 44.5 0l22.2-22.2c12.3-12.3 12.3-32.2 0-44.5L242.7 256z"/></svg>';
const ICON_ALERT = '<svg class="pf-v6-svg" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" width="1em" height="1em"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24V264c0 13.3-10.7 24-24 24s-24-10.7-24-24V152c0-13.3 10.7-24 24-24zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z"/></svg>';

// ---- theme and language -----------------------------------------------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = S.settings.theme || 'system';
  try { localStorage.setItem('charsiu.theme', pref); } catch (e) { /* convenience only */ }
  const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
  document.documentElement.classList.toggle('pf-v6-theme-dark', dark);
}
darkQuery.addEventListener('change', applyTheme);

function applyLanguage() {
  setLang(S.settings.language);
  renderAll();
}

// ---- persistence ------------------------------------------------------------

const saveConvs = debounce(() => {
  if (!invoke) return;
  invoke('save_conversations', { value: { version: 1, current: S.currentId, conversations: S.convs } })
    .catch((e) => console.error('save_conversations', e));
}, 600);

function saveSettings() {
  if (!invoke) return Promise.resolve();
  return invoke('save_settings', { value: S.settings }).catch((e) => console.error('save_settings', e));
}

// ---- conversations ------------------------------------------------------------

function current() {
  return S.convs.find((c) => c.id === S.currentId) || null;
}

function newConversation() {
  const c = { id: uid(), title: '', created: Date.now(), updated: Date.now(), messages: [] };
  S.convs.unshift(c);
  S.currentId = c.id;
  saveConvs();
  renderAll();
  $('input').focus();
}

function ensureConversation() {
  if (!current()) {
    if (S.convs.length) S.currentId = S.convs[0].id;
    else newConversation();
  }
  return current();
}

function titleOf(c) {
  return c.title || t('conv.untitled');
}

function renderConvList() {
  const ul = $('convList');
  ul.innerHTML = S.convs.map((c) => `
    <li class="conv-item${c.id === S.currentId ? ' is-current' : ''}" data-id="${esc(c.id)}">
      <button type="button" class="conv-open" data-open="${esc(c.id)}" title="${esc(titleOf(c))}">${esc(titleOf(c))}</button>
      <button type="button" class="pf-v6-c-button pf-m-plain pf-m-small" data-del="${esc(c.id)}" title="${esc(t('conv.delete'))}" aria-label="${esc(t('conv.delete'))}"><span class="pf-v6-c-button__icon">${ICON_X}</span></button>
    </li>`).join('');
}

$('convList').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  const del = e.target.closest('[data-del]');
  if (del) {
    if (S.generating && del.dataset.del === S.currentId) return;
    S.convs = S.convs.filter((c) => c.id !== del.dataset.del);
    if (S.currentId === del.dataset.del) S.currentId = S.convs.length ? S.convs[0].id : null;
    ensureConversation();
    saveConvs();
    renderAll();
  } else if (open && !S.generating) {
    S.currentId = open.dataset.open;
    saveConvs();
    renderAll();
  }
});

$('newConv').addEventListener('click', () => { if (!S.generating) newConversation(); });

$('clearConv').addEventListener('click', () => {
  const c = current();
  if (!c || S.generating) return;
  c.messages = [];
  c.title = '';
  c.updated = Date.now();
  saveConvs();
  renderAll();
});

// ---- messages -----------------------------------------------------------------

function statsText(m) {
  const st = m.stats;
  if (!st) return '';
  const parts = [];
  if (st.tps) parts.push(t('stats.tps', { tps: st.tps.toFixed(1) }));
  if (st.ttft != null) parts.push(t('stats.ttft', { s: (st.ttft / 1000).toFixed(2) }));
  if (st.tokens) parts.push(t('stats.tokens', { n: st.tokens }));
  if (st.finish === 'cancelled') parts.push(t('chat.stopped'));
  if (st.finish === 'length') parts.push(t('chat.length'));
  return parts.join(', ');
}

function messageHtml(m, i, pending) {
  const role = m.role === 'user' ? t('chat.you') : t('chat.assistant');
  const body = m.content || (pending ? '' : '');
  const meta = m.error
    ? `<div class="msg-meta msg-error">${esc(t('chat.error', { msg: m.error }))}</div>`
    : (pending && !m.content ? `<div class="msg-meta">${esc(t('chat.reading'))}</div>` : `<div class="msg-meta">${esc(statsText(m))}</div>`);
  return `
    <article class="msg msg-${m.role === 'user' ? 'user' : 'assistant'}" data-i="${i}">
      <div class="msg-head">
        <span class="msg-role">${esc(role)}</span>
        ${m.content ? `<button type="button" class="pf-v6-c-button pf-m-link pf-m-inline pf-m-small" data-copy="${i}"><span class="pf-v6-c-button__text">${esc(t('chat.copy'))}</span></button>` : ''}
      </div>
      <div class="msg-body${pending ? ' msg-pending' : ''}">${esc(body)}</div>
      ${meta}
    </article>`;
}

function emptyStateHtml() {
  const b = S.backend.state;
  let body = t('chat.emptyStopped');
  if (b === 'ready') body = t('chat.emptyReady');
  else if (b === 'starting' || b === 'loading') body = t('chat.emptyLoading');
  let progress = '';
  if (b === 'loading' && S.backend.total) {
    const pct = Math.min(100, Math.round(100 * (S.backend.staged || 0) / S.backend.total));
    progress = progressHtml(pct, t('state.loadingN', { n: S.backend.staged || 0, total: S.backend.total }), 'load');
  } else if (b === 'starting' || b === 'loading') {
    progress = '<div class="pf-v6-c-empty-state__body"><svg class="pf-v6-c-spinner pf-m-lg" role="progressbar" viewBox="0 0 100 100"><circle class="pf-v6-c-spinner__path" cx="50" cy="50" r="45" fill="none"></circle></svg></div>';
  }
  return `
    <div class="pf-v6-c-empty-state">
      <div class="pf-v6-c-empty-state__content">
        <div class="pf-v6-c-empty-state__header">
          <div class="pf-v6-c-empty-state__title"><h2 class="pf-v6-c-empty-state__title-text">${esc(t('chat.emptyTitle'))}</h2></div>
        </div>
        <div class="pf-v6-c-empty-state__body">${esc(body)}</div>
        ${progress}
      </div>
    </div>`;
}

function progressHtml(pct, label, id) {
  return `
    <div class="pf-v6-c-progress pf-m-sm" id="progress-${esc(id)}">
      <div class="pf-v6-c-progress__description">${esc(label)}</div>
      <div class="pf-v6-c-progress__status" aria-hidden="true"><span class="pf-v6-c-progress__measure">${pct}%</span></div>
      <div class="pf-v6-c-progress__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <div class="pf-v6-c-progress__indicator" style="width:${pct}%;"></div>
      </div>
    </div>`;
}

function renderMessages() {
  const c = current();
  const box = $('messages');
  if (!c || !c.messages.length) {
    box.innerHTML = emptyStateHtml();
  } else {
    const last = c.messages.length - 1;
    box.innerHTML = c.messages.map((m, i) => messageHtml(m, i, S.generating && i === last)).join('');
  }
  $('convTitle').textContent = c ? titleOf(c) : t('app.title');
}

function scrollToEnd() {
  const s = $('chatScroll');
  s.scrollTop = s.scrollHeight;
}

/** Update only the reply being written: a full re-render per token would
 * redraw the whole conversation 15 times a second. */
let paintQueued = false;
function paintLast() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    const c = current();
    if (!c || !c.messages.length) return;
    const i = c.messages.length - 1;
    const el = document.querySelector(`.msg[data-i="${i}"]`);
    const s = $('chatScroll');
    const atEnd = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
    if (!el) { renderMessages(); } else {
      el.outerHTML = messageHtml(c.messages[i], i, S.generating);
    }
    if (atEnd) scrollToEnd();
  });
}

$('messages').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const c = current();
  const m = c && c.messages[Number(b.dataset.copy)];
  if (!m) return;
  if (await copyText(m.content)) {
    const tx = b.querySelector('.pf-v6-c-button__text');
    tx.textContent = t('chat.copied');
    setTimeout(() => { tx.textContent = t('chat.copy'); }, 1200);
  }
});

// ---- sending ------------------------------------------------------------------

function requestBody(c) {
  const msgs = [];
  if (S.settings.system.trim()) msgs.push({ role: 'system', content: S.settings.system.trim() });
  for (const m of c.messages) {
    if (m.error || !m.content) continue;
    msgs.push({ role: m.role, content: m.content });
  }
  return {
    model: 'charsiu',
    messages: msgs,
    stream: true,
    max_tokens: Math.max(1, Math.min(4096, Number(S.settings.maxTokens) || DEFAULTS.maxTokens)),
    temperature: Math.max(0, Number(S.settings.temperature) || 0),
  };
}

async function send(text) {
  if (!invoke || S.generating || S.backend.state !== 'ready') return;
  const c = ensureConversation();
  c.messages.push({ role: 'user', content: text });
  if (!c.title) c.title = text.replace(/\s+/g, ' ').trim().slice(0, 48);
  const body = requestBody(c);
  const reply = { role: 'assistant', content: '', stats: null };
  c.messages.push(reply);
  c.updated = Date.now();
  S.generating = true;
  renderAll();
  scrollToEnd();

  const t0 = performance.now();
  let first = null;
  let lastAt = null;
  let n = 0;
  let settled = false;
  const finish = (how, err) => {
    if (settled) return;
    settled = true;
    if (err) reply.error = err;
    const now = lastAt || performance.now();
    reply.stats = {
      tokens: n,
      ttft: first != null ? Math.round(first - t0) : null,
      tps: n > 1 && first != null && now > first ? (n - 1) / ((now - first) / 1000) : null,
      finish: how,
    };
    if (reply.stats.tps) S.lastStats = reply.stats;
    S.generating = false;
    c.updated = Date.now();
    saveConvs();
    renderAll();
  };

  const ch = new TAURI.core.Channel();
  ch.onmessage = (ev) => {
    if (settled) return;
    if (ev.kind === 'token') {
      const now = performance.now();
      if (first == null) first = now;
      lastAt = now;
      n += 1;
      reply.content += ev.text;
      paintLast();
    } else if (ev.kind === 'done') {
      finish(ev.finish);
    } else if (ev.kind === 'error') {
      finish('error', ev.message);
    }
  };
  try {
    await invoke('chat', { body: JSON.stringify(body), onEvent: ch });
  } catch (e) {
    finish('error', String(e));
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (S.generating) {
    invoke && invoke('chat_cancel');
    return;
  }
  const v = $('input').value.trim();
  if (!v) return;
  $('input').value = '';
  send(v);
});

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

function renderComposer() {
  const btn = $('send');
  const tx = btn.querySelector('.pf-v6-c-button__text');
  if (S.generating) {
    btn.className = 'pf-v6-c-button pf-m-secondary';
    tx.textContent = t('chat.stop');
    btn.disabled = false;
  } else {
    btn.className = 'pf-v6-c-button pf-m-primary';
    tx.textContent = t('chat.send');
    btn.disabled = S.backend.state !== 'ready';
  }
  $('clearConv').disabled = S.generating;
  $('newConv').disabled = S.generating;
  $('modelSelect').disabled = S.generating;
}

// ---- the backend --------------------------------------------------------------

function startBackend() {
  if (!invoke) return;
  invoke('backend_start', { charsiu: S.settings.charsiuPath, model: S.settings.model || null })
    .catch((e) => console.error('backend_start', e));
}

function onBackend(snap) {
  const was = S.backend.state;
  S.backend = snap;
  if (snap.state === 'ready' && was !== 'ready') refreshModels();
  renderNotices();
  renderStatus();
  renderComposer();
  const c = current();
  if (!c || !c.messages.length) renderMessages();
}

function stateText(b) {
  if (b.state === 'loading' && b.total) return t('state.loadingN', { n: b.staged || 0, total: b.total });
  return t('state.' + (b.state || 'stopped'));
}

function npuText() {
  const b = S.backend;
  const parts = [];
  if (b.state === 'ready' || b.state === 'loading') {
    if (b.npu === 'on') parts.push(b.devices ? t('npu.on', { n: b.devices }) : t('npu.onPlain'));
    else if (b.npu === 'off') parts.push(t('npu.off'));
  }
  const n = S.npu;
  if (n && n.platform === 'windows') {
    if (n.device === 'started') parts.push(t('npu.winStarted'));
    else if (n.device === 'absent') parts.push(t('npu.winAbsent'));
    else if (n.device === 'problem') parts.push(t('npu.winProblem', { code: n.problem }));
    if (n.counters === 'ok') {
      for (const core of n.cores) {
        if (core.busy != null) parts.push(t('npu.busy', { core: core.name, pct: Math.round(core.busy) }));
      }
    } else if (n.device === 'started') {
      parts.push(t('npu.noCounters'));
    }
  } else if (n && n.platform === 'linux') {
    if (n.device === 'absent') parts.push(t('npu.linuxAbsent'));
    else if (!n.driverLoaded) parts.push(t('npu.linuxNoModule'));
    else parts.push(t('npu.linuxPresent'));
    if (n.cores.length) {
      const active = n.cores.filter((c) => c.state === 'active').length;
      parts.push(t('npu.coresActive', { n: active, total: n.cores.length }));
    }
  }
  return parts.length ? parts.join(', ') : t('npu.unknown');
}

function renderStatus() {
  const b = S.backend;
  $('stBackend').textContent = stateText(b) + (b.state === 'ready' && b.port ? ` (127.0.0.1:${b.port})` : '');
  const model = b.served || base(b.model) || (S.models && base(S.models.current)) || '-';
  $('stModel').textContent = model + (b.context ? `, ctx ${b.context}` : '');
  $('stNpu').textContent = npuText();
  const st = S.lastStats;
  $('stSpeed').textContent = st
    ? [t('stats.tps', { tps: st.tps.toFixed(1) }), st.ttft != null ? t('stats.ttft', { s: (st.ttft / 1000).toFixed(2) }) : ''].filter(Boolean).join(', ')
    : '-';
}

function codeBlock(text) {
  return `<div class="pf-v6-c-code-block"><div class="pf-v6-c-code-block__content"><pre class="pf-v6-c-code-block__pre"><code class="pf-v6-c-code-block__code">${esc(text)}</code></pre></div></div>`;
}

function alertHtml(kind, title, bodyHtml, actions) {
  const acts = (actions || []).map((a) =>
    `<button type="button" class="pf-v6-c-button pf-m-link pf-m-inline" data-action="${esc(a.id)}"><span class="pf-v6-c-button__text">${esc(a.label)}</span></button>`).join('');
  return `
    <div class="pf-v6-c-alert pf-m-inline pf-m-${kind}">
      <div class="pf-v6-c-alert__icon">${ICON_ALERT}</div>
      <p class="pf-v6-c-alert__title">${esc(title)}</p>
      ${bodyHtml ? `<div class="pf-v6-c-alert__description">${bodyHtml}</div>` : ''}
      ${acts ? `<div class="pf-v6-c-alert__action-group">${acts}</div>` : ''}
    </div>`;
}

function renderNotices() {
  const b = S.backend;
  const win = S.info.os === 'windows';
  const out = [];
  if (!TAURI) {
    out.push(alertHtml('danger', t('problem.browser'), '', []));
  } else if (b.state === 'failed') {
    const retry = { id: 'retry', label: t('common.retry') };
    const log = { id: 'log', label: t('common.showLog') };
    switch (b.problem) {
    case 'not_installed':
      out.push(alertHtml('danger', t('problem.notInstalled'),
        win ? `<p>${esc(t('problem.notInstalledWin'))}</p>${codeBlock(INSTALL.windows)}`
            : `<p>${esc(t('problem.notInstalledLinux'))}</p>${codeBlock(INSTALL.armbian)}${codeBlock(INSTALL.linux)}`,
        [retry, { id: 'settings', label: t('problem.setPath') }]));
      break;
    case 'no_model':
      out.push(alertHtml('warning', t('problem.noModel'), `<p>${esc(t('problem.noModelBody'))}</p>`,
        [{ id: 'models', label: t('problem.openModels') }, retry]));
      break;
    case 'model_missing':
      out.push(alertHtml('warning', t('problem.modelMissing'), `<p>${esc(t('problem.modelMissingBody'))}</p>`,
        [{ id: 'models', label: t('problem.openModels') }, retry]));
      break;
    case 'not_built':
      out.push(alertHtml('danger', t('problem.notBuilt'),
        `<p>${esc(t('problem.notBuiltBody'))}</p>${codeBlock(win ? INSTALL.windows : INSTALL.linux)}`, [retry, log]));
      break;
    default:
      out.push(alertHtml('danger', t(b.problem === 'spawn' ? 'problem.spawn' : 'problem.exited'),
        b.detail ? `<div class="notice-detail">${esc(b.detail)}</div>` : '', [retry, log]));
    }
  } else if (b.state === 'ready' || b.state === 'loading') {
    if (b.npuProblem === 'admin') {
      out.push(alertHtml('warning', t('problem.adminNeeded'),
        `<p>${esc(t('problem.adminNeededBody'))}</p>${codeBlock(INSTALL.windowsUser)}`, []));
    } else if (b.npuProblem === 'driver' || (b.npu === 'off' && win && b.state === 'ready')) {
      out.push(alertHtml('warning', t('problem.driverWin'),
        `<p>${esc(t('problem.driverWinBody'))}</p>${codeBlock(INSTALL.windows)}`, [{ id: 'log', label: t('common.showLog') }]));
    } else if (b.npu === 'off' && !win && b.state === 'ready') {
      out.push(alertHtml('warning', t('problem.cpuLinux'),
        `<p>${esc(t('problem.cpuLinuxBody'))}</p>${codeBlock(INSTALL.linux)}`, [{ id: 'log', label: t('common.showLog') }]));
    }
  }
  $('notices').innerHTML = out.join('');
}

$('notices').addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  if (a.dataset.action === 'retry') startBackend();
  else if (a.dataset.action === 'models') openModels();
  else if (a.dataset.action === 'settings') openSettings();
  else if (a.dataset.action === 'log') openLog();
});

// ---- NPU status, every 2 s while the window is visible -------------------------

let npuTimer = null;
async function pollNpu() {
  if (!invoke) return;
  try { S.npu = await invoke('npu_status'); } catch (e) { S.npu = null; }
  renderStatus();
}
function npuPolling() {
  clearInterval(npuTimer);
  npuTimer = null;
  if (document.visibilityState === 'visible') {
    pollNpu();
    npuTimer = setInterval(pollNpu, 2000);
  }
}
document.addEventListener('visibilitychange', npuPolling);

// ---- models -------------------------------------------------------------------

async function refreshModels() {
  if (!invoke) return;
  try {
    S.models = await invoke('models_list', { charsiu: S.settings.charsiuPath });
    S.modelsError = '';
  } catch (e) {
    S.models = null;
    S.modelsError = String(e);
  }
  renderModelSelect();
  renderModels();
  renderStatus();
}

function renderModelSelect() {
  const sel = $('modelSelect');
  const opts = [`<option value="">${esc(t('bar.modelDefault'))}</option>`];
  const inst = S.models ? S.models.installed : [];
  for (const m of inst) {
    opts.push(`<option value="${esc(m.path)}">${esc(m.file)}</option>`);
  }
  if (S.settings.model && !inst.some((m) => m.path === S.settings.model)) {
    opts.push(`<option value="${esc(S.settings.model)}">${esc(base(S.settings.model))}</option>`);
  }
  sel.innerHTML = opts.join('');
  sel.value = S.settings.model || '';
}

$('modelSelect').addEventListener('change', (e) => useModel(e.target.value));

function useModel(path) {
  S.settings.model = path || '';
  saveSettings();
  renderModelSelect();
  startBackend();
  renderModels();
}

function inUse(path) {
  const b = S.backend;
  if (S.settings.model) return S.settings.model === path;
  return (b.model && b.model === path) || (S.models && S.models.current === path) || false;
}

function renderModels() {
  const body = $('modelsBody');
  if ($('modelsModal').hidden) return;
  if (S.modelsError) {
    body.innerHTML = alertHtml('danger', t('models.loadError', { msg: S.modelsError }), '', []);
    return;
  }
  const M = S.models;
  if (!M) {
    body.innerHTML = `<p>${esc(t('models.loading'))}</p>`;
    return;
  }
  const p = S.pull;
  const parts = [`<p class="models-where">${esc(t('models.where', { dir: M.dir }))}</p>`];

  if (p && p.state === 'failed') parts.push(alertHtml('danger', t('models.failed', { msg: p.message || '' }), '', []));
  if (p && p.state === 'cancelled') parts.push(alertHtml('info', t('models.cancelled'), '', []));
  if (p && p.state === 'done') parts.push(alertHtml('success', t('models.done', { name: p.name }), '', []));

  parts.push(`<h2>${esc(t('models.installed'))}</h2>`);
  if (!M.installed.length) {
    parts.push(`<p>${esc(t('models.none'))}</p>`);
  } else {
    parts.push(`<table class="pf-v6-c-table pf-m-compact pf-m-grid-md models-table"><thead class="pf-v6-c-table__thead"><tr class="pf-v6-c-table__tr">
      <th class="pf-v6-c-table__th" scope="col">${esc(t('models.colName'))}</th>
      <th class="pf-v6-c-table__th nowrap" scope="col">${esc(t('models.colSize'))}</th>
      <th class="pf-v6-c-table__th" scope="col">${esc(t('models.colStatus'))}</th>
      <th class="pf-v6-c-table__th" scope="col"></th></tr></thead><tbody class="pf-v6-c-table__tbody">`);
    for (const m of M.installed) {
      const using = inUse(m.path);
      const armed = S.removeArmed === m.path;
      const acts = [];
      if (!using) acts.push(`<button type="button" class="pf-v6-c-button pf-m-secondary pf-m-small" data-use="${esc(m.path)}"><span class="pf-v6-c-button__text">${esc(t('models.use'))}</span></button>`);
      if (!m.system && !using) {
        acts.push(`<button type="button" class="pf-v6-c-button ${armed ? 'pf-m-danger' : 'pf-m-link pf-m-danger'} pf-m-small" data-rm="${esc(m.path)}" data-file="${esc(m.file)}"><span class="pf-v6-c-button__text">${esc(t(armed ? 'models.confirmRemove' : 'models.remove'))}</span></button>`);
      }
      parts.push(`<tr class="pf-v6-c-table__tr">
        <td class="pf-v6-c-table__td" data-label="${esc(t('models.colName'))}">${esc(m.file)}</td>
        <td class="pf-v6-c-table__td nowrap" data-label="${esc(t('models.colSize'))}">${esc(mb(m.bytes))}</td>
        <td class="pf-v6-c-table__td" data-label="${esc(t('models.colStatus'))}">${esc(using ? t('models.inUse') : (m.system ? t('models.system') : ''))}</td>
        <td class="pf-v6-c-table__td"><div class="cell-actions">${acts.join('')}</div></td></tr>`);
    }
    parts.push('</tbody></table>');
  }

  parts.push(`<h2>${esc(t('models.available'))}</h2>`);
  parts.push(`<table class="pf-v6-c-table pf-m-compact pf-m-grid-md models-table"><thead class="pf-v6-c-table__thead"><tr class="pf-v6-c-table__tr">
    <th class="pf-v6-c-table__th" scope="col">${esc(t('models.colName'))}</th>
    <th class="pf-v6-c-table__th nowrap" scope="col">${esc(t('models.colSize'))}</th>
    <th class="pf-v6-c-table__th" scope="col">${esc(t('models.colNote'))}</th>
    <th class="pf-v6-c-table__th" scope="col"></th></tr></thead><tbody class="pf-v6-c-table__tbody">`);
  const running = p && p.state === 'running';
  for (const r of M.zoo) {
    let cell;
    if (running && p.name === r.name) {
      const pct = p.total ? Math.min(100, Math.floor(100 * p.bytes / p.total)) : 0;
      const label = p.bytes >= p.total && p.total ? t('models.verifying')
        : t('models.progress', { got: mb(p.bytes), total: mb(p.total) });
      cell = progressHtml(pct, label, r.name) +
        `<button type="button" class="pf-v6-c-button pf-m-link pf-m-inline pf-m-small" data-cancel><span class="pf-v6-c-button__text">${esc(t('models.cancel'))}</span></button>`;
    } else if (r.installed) {
      cell = esc(t('models.downloaded'));
    } else {
      cell = `<button type="button" class="pf-v6-c-button pf-m-secondary pf-m-small" data-pull="${esc(r.name)}"${running ? ' disabled' : ''}><span class="pf-v6-c-button__text">${esc(t('models.download'))}</span></button>`;
    }
    parts.push(`<tr class="pf-v6-c-table__tr">
      <td class="pf-v6-c-table__td" data-label="${esc(t('models.colName'))}">${esc(r.name)}</td>
      <td class="pf-v6-c-table__td nowrap" data-label="${esc(t('models.colSize'))}">${esc(mb(r.totalMb * 1048576))}</td>
      <td class="pf-v6-c-table__td models-note" data-label="${esc(t('models.colNote'))}">${esc(r.note)}</td>
      <td class="pf-v6-c-table__td">${cell}</td></tr>`);
  }
  parts.push('</tbody></table>');
  body.innerHTML = parts.join('');
}

$('modelsBody').addEventListener('click', async (e) => {
  const use = e.target.closest('[data-use]');
  const rm = e.target.closest('[data-rm]');
  const pull = e.target.closest('[data-pull]');
  const cancel = e.target.closest('[data-cancel]');
  if (use) {
    useModel(use.dataset.use);
    closeModal('modelsModal');
  } else if (rm) {
    if (S.removeArmed !== rm.dataset.rm) {
      S.removeArmed = rm.dataset.rm;
      renderModels();
      return;
    }
    S.removeArmed = '';
    try {
      await invoke('model_remove', { charsiu: S.settings.charsiuPath, file: rm.dataset.file });
    } catch (err) {
      S.modelsError = String(err);
    }
    await refreshModels();
  } else if (pull) {
    startPull(pull.dataset.pull);
  } else if (cancel) {
    await invoke('pull_cancel');
    await pollPull();
  }
});

async function startPull(name) {
  const r = S.models && S.models.zoo.find((z) => z.name === name);
  if (!r) return;
  try {
    await invoke('pull_start', {
      charsiu: S.settings.charsiuPath,
      req: { name: r.name, file: r.file, mmproj: r.mmproj || '', totalMb: r.totalMb, dir: S.models.dir },
    });
  } catch (e) {
    S.pull = { name, state: 'failed', message: String(e), bytes: 0, total: 0 };
    renderModels();
    return;
  }
  clearInterval(S.pullTimer);
  S.pullTimer = setInterval(pollPull, 500);
  pollPull();
}

async function pollPull() {
  const p = await invoke('pull_status');
  S.pull = p;
  if (p.state !== 'running') {
    clearInterval(S.pullTimer);
    S.pullTimer = null;
    await refreshModels();
    // the first model on a fresh install: start serving it straight away
    if (p.state === 'done' && S.backend.state === 'failed' && S.models) {
      const r = S.models.zoo.find((z) => z.name === p.name);
      const m = r && S.models.installed.find((i) => i.file === r.file);
      if (m) useModel(m.path);
    }
  }
  renderModels();
}

// ---- dialogs ------------------------------------------------------------------

function openModal(id) {
  $(id).hidden = false;
  const f = $(id).querySelector('input, select, textarea, button');
  if (f) f.focus();
}

function closeModal(id) {
  $(id).hidden = true;
  if (id === 'modelsModal') S.removeArmed = '';
}

for (const id of ['modelsModal', 'settingsModal', 'logModal']) {
  $(id).addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal(id);
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const id of ['modelsModal', 'settingsModal', 'logModal']) if (!$(id).hidden) closeModal(id);
});

function openModels() {
  openModal('modelsModal');
  renderModels();
  refreshModels();
}
$('openModels').addEventListener('click', openModels);

function openSettings() {
  const s = S.settings;
  $('setTemp').value = s.temperature;
  $('setMax').value = s.maxTokens;
  $('setSystem').value = s.system;
  $('setLang').value = s.language || '';
  $('setTheme').value = s.theme || 'system';
  $('setCharsiu').value = s.charsiuPath || '';
  $('setCharsiu').placeholder = S.info.charsiu || '';
  $('setCharsiuHelp').textContent = S.info.charsiu
    ? t('settings.charsiuHelp', { path: S.info.charsiu }) : t('settings.charsiuNone');
  openModal('settingsModal');
}
$('openSettings').addEventListener('click', openSettings);

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = S.settings;
  const oldPath = s.charsiuPath;
  const temp = Number($('setTemp').value);
  const max = Math.round(Number($('setMax').value));
  s.temperature = Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : DEFAULTS.temperature;
  s.maxTokens = Number.isFinite(max) && max > 0 ? Math.min(4096, max) : DEFAULTS.maxTokens;
  s.system = $('setSystem').value;
  s.language = $('setLang').value;
  s.theme = $('setTheme').value;
  s.charsiuPath = $('setCharsiu').value.trim();
  await saveSettings();
  closeModal('settingsModal');
  applyTheme();
  applyLanguage();
  if (s.charsiuPath !== oldPath) {
    startBackend();
    refreshModels();
  }
});

async function openLog() {
  let lines = [];
  try { lines = await invoke('backend_log'); } catch (e) { lines = [String(e)]; }
  $('logText').textContent = lines.length ? lines.join('\n') : t('log.empty');
  openModal('logModal');
  const pre = $('logText');
  pre.scrollTop = pre.scrollHeight;
}
$('openLog').addEventListener('click', openLog);

// ---- start --------------------------------------------------------------------

function renderAll() {
  renderConvList();
  renderMessages();
  renderNotices();
  renderStatus();
  renderComposer();
  renderModelSelect();
  renderModels();
}

async function main() {
  setLang('');
  if (!TAURI) {
    renderAll();
    return;
  }
  try {
    const d = await invoke('load_data');
    if (d.settings && typeof d.settings === 'object') S.settings = { ...DEFAULTS, ...d.settings };
    const cv = d.conversations;
    if (cv && Array.isArray(cv.conversations)) {
      S.convs = cv.conversations.filter((c) => c && Array.isArray(c.messages));
      S.currentId = cv.current || null;
    }
  } catch (e) {
    console.error('load_data', e);
  }
  try { S.info = await invoke('app_info'); } catch (e) { console.error('app_info', e); }
  applyTheme();
  setLang(S.settings.language);
  ensureConversation();
  await TAURI.event.listen('backend', (e) => onBackend(e.payload));
  onBackend(await invoke('backend_state'));
  renderAll();
  npuPolling();
  startBackend();
  refreshModels();
}

main();
