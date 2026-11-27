// Charsiu Desktop, the page: the PatternFly Chatbot extension's "Fullscreen
// chatbot with docked navigation" demo (the chatbot fills the window, a
// docked rail with the history toggle, the logo, New chat, Export and Settings; the
// history drawer; the message box, message bar and footnote; settings drawn in
// place of the conversation), with this app's content. Everything that
// touches the system is a Rust command (src/api.ts); this keeps the conversations and draws.
// SPDX-License-Identifier: GPL-2.0-only
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Alert, AlertActionCloseButton, AlertActionLink, AlertGroup, Brand, CodeBlock, CodeBlockCode, Content, Divider, DropdownItem, Masthead, MastheadBrand, MastheadContent,
  MastheadLogo, MastheadMain, MastheadToggle, Nav, NavItem, NavList, PageToggleButton, Progress, ProgressMeasureLocation,
  ProgressSize, Tooltip,
} from '@patternfly/react-core';
import { RhUiEditFillIcon } from '@patternfly/react-icons/dist/esm/icons/rh-ui-edit-fill-icon';
import { RhUiExportFillIcon } from '@patternfly/react-icons/dist/esm/icons/rh-ui-export-fill-icon';
import { RhUiSettingsFillIcon } from '@patternfly/react-icons/dist/esm/icons/rh-ui-settings-fill-icon';
import { RedoIcon } from '@patternfly/react-icons/dist/esm/icons/redo-icon';
import Chatbot, { ChatbotDisplayMode } from '@patternfly/chatbot/dist/dynamic/Chatbot';
import ChatbotAlert from '@patternfly/chatbot/dist/dynamic/ChatbotAlert';
import ChatbotContent from '@patternfly/chatbot/dist/dynamic/ChatbotContent';
import ChatbotWelcomePrompt from '@patternfly/chatbot/dist/dynamic/ChatbotWelcomePrompt';
import ChatbotFooter, { ChatbotFootnote } from '@patternfly/chatbot/dist/dynamic/ChatbotFooter';
import MessageBar from '@patternfly/chatbot/dist/dynamic/MessageBar';
import MessageBox, { type MessageBoxHandle } from '@patternfly/chatbot/dist/dynamic/MessageBox';
import Message from '@patternfly/chatbot/dist/dynamic/Message';
import ChatbotConversationHistoryNav, { type Conversation } from '@patternfly/chatbot/dist/dynamic/ChatbotConversationHistoryNav';
import {
  base, channel, DEFAULTS, INSTALL, invoke, tauri, uid, copyText,
  type ChatEvent, type Conv, type Info, type Models, type Msg, type NpuStatus, type PullStatus, type Settings, type Snapshot,
} from './api';
import { useI18n } from './i18n';
import { fileName, toMarkdown } from './export';
import type { T } from './i18n-core';
import { applyTheme, followSystem } from './theme';
import { AboutModal, ConfirmDelete, LogModal, RenameModal, SettingsModal } from './dialogs';
import { SettingsPanel } from './settings-panel';
import { ModelsModal } from './models';
import botAvatar from '../src-tauri/icons/128x128.png';
import userAvatar from './user-avatar.svg';

// The rail's hover styles, verbatim from the demo.
const hamburgerHoverStyles = `
  .pf-chatbot__canvas-docked-nav .pf-v6-c-masthead__logo.pf-m-compact {
    display: revert;
  }

  .pf-chatbot__canvas-docked-nav .pf-v6-c-nav.pf-m-docked .pf-v6-c-nav__link-text {
    display: none;
  }

  .pf-chatbot__canvas-history-toggle.pf-v6-c-button.pf-m-hamburger:is(:hover, :focus-visible) {
    --pf-v6-c-button--hamburger-icon--top--path: var(--pf-v6-c-button--hamburger-icon--top--collapse--path);
    --pf-v6-c-button--hamburger-icon--arrow--path: var(--pf-v6-c-button--hamburger-icon--arrow--collapse--path);
    --pf-v6-c-button--hamburger-icon--bottom--path: var(--pf-v6-c-button--hamburger-icon--bottom--collapse--path);
    --pf-v6-c-button__icon--TransitionDelay: 0s;
    --pf-v6-c-button__icon--ScaleX: var(--pf-v6-c-button--m-hamburger__icon--m-expand--ScaleX);
  }

  .pf-chatbot__canvas-history-toggle.pf-v6-c-button.pf-m-hamburger[aria-expanded="true"]:is(:hover, :focus-visible) {
    --pf-v6-c-button__icon--ScaleX: var(--pf-v6-c-button--m-hamburger__icon--m-collapse--ScaleX);
  }
`;

/** A model file's name as people say it: no folder, no .gguf. */
export const modelName = (p: string) => base(p).replace(/\.gguf$/i, '');

// ---- words for the state ---------------------------------------------------------

export function stateText(b: Snapshot, t: T): string {
  if (b.state === 'loading' && b.port) return t('state.ready');
  if (b.state === 'loading' && b.total) return t('state.loadingN', { n: b.staged || 0, total: b.total });
  return t(`state.${b.state || 'stopped'}`);
}

export function npuWords(b: Snapshot, n: NpuStatus | null, t: T): string[] {
  const parts: string[] = [];
  if (b.state === 'ready' || b.state === 'loading') {
    if (b.npu === 'on') parts.push(b.devices ? t('npu.on', { n: b.devices }) : t('npu.onPlain'));
    else if (b.npu === 'off') parts.push(t('npu.off'));
  }
  if (n && n.platform === 'windows') {
    if (n.device === 'started') parts.push(t('npu.winStarted'));
    else if (n.device === 'absent') parts.push(t('npu.winAbsent'));
    else if (n.device === 'problem') parts.push(t('npu.winProblem', { code: n.problem ?? '?' }));
    if (n.counters === 'ok') {
      for (const c of n.cores) if (c.busy != null) parts.push(t('npu.busy', { core: c.name, pct: Math.round(c.busy) }));
    } else if (n.device === 'started') parts.push(t('npu.noCounters'));
  } else if (n && n.platform === 'linux') {
    if (n.device === 'absent') parts.push(t('npu.linuxAbsent'));
    else if (!n.driverLoaded) parts.push(t('npu.linuxNoModule'));
    else parts.push(t('npu.linuxPresent'));
    if (n.cores.length) {
      const active = n.cores.filter((c) => c.state === 'active').length;
      parts.push(t('npu.coresActive', { n: active, total: n.cores.length }));
    }
  }
  return parts.length ? parts : [t('npu.unknown')];
}

function statsText(m: Msg, t: T): string {
  const st = m.stats;
  if (!st) return '';
  const parts: string[] = [];
  if (st.tps) parts.push(t('stats.tps', { tps: st.tps.toFixed(1) }));
  if (st.ttft != null) parts.push(t('stats.ttft', { s: (st.ttft / 1000).toFixed(2) }));
  if (st.tokens) parts.push(t('stats.tokens', { n: st.tokens }));
  if (st.finish === 'cancelled') parts.push(t('chat.stopped'));
  if (st.finish === 'length') parts.push(t('chat.length'));
  return parts.join(', ');
}

const titleOf = (c: Conv, t: T) => c.title || t('conv.untitled');

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---- the page --------------------------------------------------------------------

export function App({ settings, setSettings }: { settings: Settings; setSettings: (s: Settings) => void }) {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<Info>({ os: '', version: '', charsiu: '' });
  const [convs, setConvs] = useState<Conv[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [backend, setBackend] = useState<Snapshot>({ state: 'stopped', npu: 'unknown' });
  const [npu, setNpu] = useState<NpuStatus | null>(null);
  const [models, setModels] = useState<Models | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [pull, setPull] = useState<PullStatus | null>(null);
  const [generating, setGeneratingState] = useState(false);
  const generatingRef = useRef(false);
  const setGenerating = (v: boolean) => { generatingRef.current = v; setGeneratingState(v); };
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [areSettingsOpen, setAreSettingsOpen] = useState(false);
  const newChatRef = useRef<HTMLAnchorElement>(null);
  const exportRef = useRef<HTMLAnchorElement>(null);
  const [toast, setToast] = useState<{ variant: 'success' | 'danger'; title: string; body?: string } | null>(null);
  const messageBoxRef = useRef<MessageBoxHandle>(null);
  const settingsNavRef = useRef<HTMLAnchorElement>(null);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<'' | 'models' | 'settings' | 'about' | 'log'>('');
  const [renaming, setRenaming] = useState<Conv | null>(null);
  const [deleting, setDeleting] = useState<Conv | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [loaded, setLoaded] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const convsRef = useRef(convs);
  convsRef.current = convs;

  // ---- persistence

  const saveTimer = useRef<number | undefined>(undefined);
  const saveConvs = useCallback((list: Conv[], cur: string | null) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (!tauri()) return;
      invoke('save_conversations', { value: { version: 1, current: cur, conversations: list } })
        .catch((e) => console.error('save_conversations', e));
    }, 600);
  }, []);

  const update = useCallback((fn: (list: Conv[]) => Conv[], cur?: string | null) => {
    setConvs((old) => {
      const next = fn(old);
      saveConvs(next, cur === undefined ? currentIdRef.current : cur);
      return next;
    });
  }, [saveConvs]);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  const current = convs.find((c) => c.id === currentId) ?? null;
  // A server that has said its port is serving. A staging heartbeat after
  // that (the last one for 113 tensors is 112) must never take Send away:
  // that was the 0.1.0 board bug.
  const serving = backend.state === 'ready' || (backend.state === 'loading' && !!backend.port);

  // ---- the backend

  const startBackend = useCallback((model?: string) => {
    if (!tauri()) return;
    const s = settingsRef.current;
    const m = model === undefined ? s.model : model;
    invoke('backend_start', { charsiu: s.charsiuPath, model: m || null }).catch((e) => console.error('backend_start', e));
  }, []);

  const refreshModels = useCallback(async () => {
    if (!tauri()) return;
    try {
      setModels(await invoke<Models>('models_list', { charsiu: settingsRef.current.charsiuPath }));
      setModelsError('');
    } catch (e) {
      setModels(null);
      setModelsError(String(e));
    }
  }, []);

  const prevState = useRef<string>('stopped');
  useEffect(() => {
    if (backend.state === 'ready' && prevState.current !== 'ready') refreshModels();
    prevState.current = backend.state;
  }, [backend.state, refreshModels]);

  // ---- start

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      const tt = tauri();
      if (!tt) { setLoaded(true); return; }
      try {
        const d = await invoke<{ conversations?: { current?: string; conversations?: Conv[] } }>('load_data');
        const cv = d.conversations;
        if (cv && Array.isArray(cv.conversations)) {
          const list = cv.conversations
            .filter((c) => c && Array.isArray(c.messages))
            .map((c) => ({ ...c, messages: c.messages.map((m) => ({ ...m, id: m.id || uid() })) }));
          setConvs(list);
          setCurrentId(cv.current && list.some((c) => c.id === cv.current) ? cv.current : list[0]?.id ?? null);
        }
      } catch (e) { console.error('load_data', e); }
      try { setInfo(await invoke<Info>('app_info')); } catch (e) { console.error('app_info', e); }
      unlisten = await tt.event.listen<Snapshot>('backend', (e) => setBackend(e.payload));
      setBackend(await invoke<Snapshot>('backend_state'));
      setLoaded(true);
      startBackend();
      refreshModels();
    })();
    return () => { if (unlisten) unlisten(); };
  }, [startBackend, refreshModels]);

  // A conversation opens at its latest message (smart scroll follows from
  // there while a reply streams).
  useEffect(() => {
    window.requestAnimationFrame(() => messageBoxRef.current?.scrollToBottom({ resumeSmartScroll: true }));
  }, [currentId, loaded, areSettingsOpen]);

  // ---- theme

  useEffect(() => { applyTheme(settings.theme); }, [settings.theme]);
  useEffect(() => followSystem(() => settingsRef.current.theme), []);

  // ---- NPU status, every 2 s while the window is visible

  useEffect(() => {
    if (!tauri()) return undefined;
    let timer: number | undefined;
    const poll = () => { invoke<NpuStatus>('npu_status').then(setNpu).catch(() => setNpu(null)); };
    const arm = () => {
      window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === 'visible') { poll(); timer = window.setInterval(poll, 2000); }
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', arm); };
  }, []);

  // ---- conversations

  const newConversation = () => {
    if (generating) return;
    const c: Conv = { id: uid(), title: '', created: Date.now(), updated: Date.now(), messages: [] };
    setCurrentId(c.id);
    update((list) => [c, ...list], c.id);
  };

  const ensureConversation = (): Conv => {
    const have = convsRef.current.find((c) => c.id === currentIdRef.current);
    if (have) return have;
    const c: Conv = { id: uid(), title: '', created: Date.now(), updated: Date.now(), messages: [] };
    setCurrentId(c.id);
    currentIdRef.current = c.id;
    convsRef.current = [c, ...convsRef.current];
    update((list) => [c, ...list], c.id);
    return c;
  };

  const setMessages = (id: string, fn: (m: Msg[]) => Msg[], title?: string) => {
    update((list) => list.map((c) => (c.id === id
      ? { ...c, messages: fn(c.messages), title: title !== undefined && !c.title ? title : c.title, updated: Date.now() }
      : c)));
  };

  // ---- sending

  const requestBody = (history: Msg[]) => {
    const s = settingsRef.current;
    const msgs: Array<{ role: string; content: string }> = [];
    if (s.system.trim()) msgs.push({ role: 'system', content: s.system.trim() });
    for (const m of history) if (!m.error && m.content) msgs.push({ role: m.role, content: m.content });
    return {
      model: 'charsiu', messages: msgs, stream: true,
      max_tokens: Math.max(1, Math.min(4096, Number(s.maxTokens) || DEFAULTS.maxTokens)),
      temperature: Math.max(0, Number(s.temperature) || 0),
    };
  };

  const ask = async (conv: Conv, history: Msg[]) => {
    const reply: Msg = { id: uid(), role: 'assistant', content: '', stats: null, at: Date.now() };
    setMessages(conv.id, () => [...history, reply], history.length && history[0].role === 'user' && !conv.title
      ? history[0].content.replace(/\s+/g, ' ').trim().slice(0, 48) : undefined);
    setGenerating(true);
    setAnnouncement(t('chat.loadingWord'));
    const body = requestBody(history);
    const t0 = performance.now();
    let first: number | null = null;
    let lastAt: number | null = null;
    let n = 0;
    let text = '';
    let settled = false;
    let painted = 0;
    const paint = () => {
      painted = 0;
      setMessages(conv.id, (ms) => ms.map((m) => (m.id === reply.id ? { ...m, content: text } : m)));
    };
    const finish = (how: string, err?: string) => {
      if (settled) return;
      settled = true;
      if (painted) cancelAnimationFrame(painted);
      const now = lastAt || performance.now();
      const stats = {
        tokens: n,
        ttft: first != null ? Math.round(first - t0) : null,
        tps: n > 1 && first != null && now > first ? (n - 1) / ((now - first) / 1000) : null,
        finish: how,
      };
      setMessages(conv.id, (ms) => ms.map((m) => (m.id === reply.id ? { ...m, content: text, stats, error: err } : m)));
      setGenerating(false);
      setAnnouncement(text ? `${t('chat.assistant')}: ${text.slice(0, 200)}` : '');
    };
    const ch = channel<ChatEvent>((ev) => {
      if (settled) return;
      if (ev.kind === 'token') {
        const now = performance.now();
        if (first == null) first = now;
        lastAt = now;
        n += 1;
        text += ev.text;
        // one repaint a frame, not one a token
        if (!painted) painted = requestAnimationFrame(paint);
      } else if (ev.kind === 'done') finish(ev.finish);
      else if (ev.kind === 'error') finish('error', ev.message);
    });
    try {
      await invoke('chat', { body: JSON.stringify(body), onEvent: ch });
      // The command has returned, so the reply is over and Send must come
      // back even if no "done" arrives. Channel messages can trail the
      // command's own answer, so give them a moment first.
      window.setTimeout(() => finish(n ? 'stop' : 'error', n ? undefined : t('chat.noReply')), 1500);
    } catch (e) {
      finish('error', String(e));
    }
  };

  const send = (raw: string | number) => {
    const text = String(raw).trim();
    if (!text || generatingRef.current || !serving || !tauri()) return;
    const c = ensureConversation();
    const user: Msg = { id: uid(), role: 'user', content: text, at: Date.now() };
    const conv = convsRef.current.find((x) => x.id === c.id) ?? c;
    ask(conv, [...conv.messages, user]);
  };

  const stop = () => { if (tauri()) invoke('chat_cancel').catch(() => {}); };

  const regenerate = () => {
    if (!current || generatingRef.current || !serving) return;
    const ms = current.messages;
    let end = ms.length;
    while (end > 0 && ms[end - 1].role === 'assistant') end -= 1;
    if (end === 0) return;
    ask(current, ms.slice(0, end));
  };


  // ---- export: the conversation as a Markdown file, where the user picks

  const exportConv = async (c: Conv) => {
    if (!tauri() || !c.messages.some((m) => m.content.trim())) return;
    const text = toMarkdown(c, { untitled: t('conv.untitled'), you: t('export.you'), assistant: t('export.assistant'), colon: t('export.colon') });
    try {
      const path = await invoke<string | null>('export_markdown', {
        title: t('export.dialog'), name: fileName(titleOf(c, t), t('export.fallback')), text,
      });
      if (path) setToast({ variant: 'success', title: t('export.saved'), body: path });
    } catch (e) {
      setToast({ variant: 'danger', title: t('export.failed'), body: String(e) });
    }
  };

  // ---- models

  const useModel = (path: string) => {
    const s = { ...settingsRef.current, model: path };
    settingsRef.current = s;
    setSettings(s);
    startBackend(path);
  };

  // ---- the history drawer

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = convs.filter((c) => !q || titleOf(c, t).toLowerCase().includes(q)
      || c.messages.some((m) => m.content.toLowerCase().includes(q)));
    const today = startOfToday();
    const item = (c: Conv): Conversation => ({
      id: c.id,
      text: titleOf(c, t),
      label: t('conv.actions', { title: titleOf(c, t) }),
      menuItems: [
        <DropdownItem key="rename" value="rename" onClick={() => setRenaming(c)}>{t('conv.rename')}</DropdownItem>,
        <DropdownItem key="export" value="export" isDisabled={!c.messages.some((m) => m.content.trim())}
          onClick={() => exportConv(c)}>{t('export.menu')}</DropdownItem>,
        <DropdownItem key="delete" value="delete" isDanger isDisabled={generating && c.id === currentId}
          onClick={() => setDeleting(c)}>{t('common.delete')}</DropdownItem>,
      ],
    });
    const out: { [key: string]: Conversation[] } = {};
    const a = list.filter((c) => c.updated >= today).map(item);
    const b = list.filter((c) => c.updated < today).map(item);
    if (a.length) out[t('conv.today')] = a;
    if (b.length) out[t('conv.earlier')] = b;
    return out;
  }, [convs, search, t, generating, currentId]);

  // ---- notices: each failure in words, with what to do about it

  const loadingProgress = backend.state === 'loading' && backend.total
    ? Math.min(100, Math.round((100 * (backend.staged || 0)) / backend.total)) : null;
  const win = info.os === 'windows';
  const notices: React.ReactNode[] = [];
  const code = (s: string) => <CodeBlock key={s}><CodeBlockCode>{s}</CodeBlockCode></CodeBlock>;
  if (loaded && !tauri()) {
    notices.push(<ChatbotAlert key="browser" variant="danger" title={t('problem.browser')} />);
  } else if (backend.state === 'failed') {
    const retry = <AlertActionLink key="retry" onClick={() => startBackend()}>{t('common.retry')}</AlertActionLink>;
    const log = <AlertActionLink key="log" onClick={() => setDialog('log')}>{t('common.showLog')}</AlertActionLink>;
    const open = <AlertActionLink key="models" onClick={() => setDialog('models')}>{t('problem.openModels')}</AlertActionLink>;
    switch (backend.problem) {
      case 'not_installed':
        notices.push(
          <ChatbotAlert key="p" variant="danger" title={t('problem.notInstalled')}
            actionLinks={[retry, <AlertActionLink key="set" onClick={() => setDialog('settings')}>{t('problem.setPath')}</AlertActionLink>]}>
            <p>{t(win ? 'problem.notInstalledWin' : 'problem.notInstalledLinux')}</p>
            {win ? code(INSTALL.windows) : <>{code(INSTALL.armbian)}{code(INSTALL.linux)}</>}
          </ChatbotAlert>,
        );
        break;
      case 'no_model':
        notices.push(<ChatbotAlert key="p" variant="warning" title={t('problem.noModel')} actionLinks={[open, retry]}><p>{t('problem.noModelBody')}</p></ChatbotAlert>);
        break;
      case 'model_missing':
        notices.push(<ChatbotAlert key="p" variant="warning" title={t('problem.modelMissing')} actionLinks={[open, retry]}><p>{t('problem.modelMissingBody')}</p></ChatbotAlert>);
        break;
      case 'not_built':
        notices.push(
          <ChatbotAlert key="p" variant="danger" title={t('problem.notBuilt')} actionLinks={[retry, log]}>
            <p>{t('problem.notBuiltBody')}</p>{code(win ? INSTALL.windows : INSTALL.linux)}
          </ChatbotAlert>,
        );
        break;
      default:
        notices.push(
          <ChatbotAlert key="p" variant="danger" title={t(backend.problem === 'spawn' ? 'problem.spawn' : 'problem.exited')} actionLinks={[retry, log]}>
            {backend.detail && code(backend.detail)}
          </ChatbotAlert>,
        );
    }
  } else if (backend.state === 'ready' || backend.state === 'loading') {
    if (backend.npuProblem === 'admin') {
      // a restart of Windows fixes it for good (UserAccess), this app as administrator fixes it now
      const elevate = win && !info.elevated
        ? [<AlertActionLink key="admin" onClick={() => { invoke('relaunch_as_admin').catch((e) => console.error('relaunch_as_admin', e)); }}>{t('problem.restartAdmin')}</AlertActionLink>]
        : [];
      notices.push(<ChatbotAlert key="n" variant="warning" title={t('problem.adminNeeded')} actionLinks={elevate}><p>{t('problem.adminNeededBody')}</p>{code(INSTALL.windows)}</ChatbotAlert>);
    } else if (backend.npuProblem === 'driver' || (backend.npu === 'off' && win && backend.state === 'ready')) {
      notices.push(
        <ChatbotAlert key="n" variant="warning" title={t('problem.driverWin')}
          actionLinks={[<AlertActionLink key="log" onClick={() => setDialog('log')}>{t('common.showLog')}</AlertActionLink>]}>
          <p>{t('problem.driverWinBody')}</p>{code(INSTALL.windows)}
        </ChatbotAlert>,
      );
    } else if (backend.npu === 'off' && !win && backend.state === 'ready') {
      notices.push(
        <ChatbotAlert key="n" variant="warning" title={t('problem.cpuLinux')}
          actionLinks={[<AlertActionLink key="log" onClick={() => setDialog('log')}>{t('common.showLog')}</AlertActionLink>]}>
          <p>{t('problem.cpuLinuxBody')}</p>{code(INSTALL.linux)}
        </ChatbotAlert>,
      );
    }
  }

  if (backend.state === 'starting' || backend.state === 'loading') {
    if (!serving) {
      notices.push(
        <ChatbotAlert key="loading" variant="info" title={t('state.loadingTitle')}>
          <p>{t('loading.body')}</p>
          {loadingProgress != null && (
            <Progress value={loadingProgress} size={ProgressSize.sm} measureLocation={ProgressMeasureLocation.outside}
              aria-label={stateText(backend, t)} />
          )}
        </ChatbotAlert>,
      );
    }
  }

  // ---- the footnote: the status in a few words; the rest under Options, Status

  const lastStats = useMemo(() => {
    for (const c of convs) for (let i = c.messages.length - 1; i >= 0; i--) {
      const s = c.messages[i].stats;
      if (s && s.tps) return s;
    }
    return null;
  }, [convs]);
  const npuLine = npuWords(backend, npu, t);
  const served = backend.served || base(backend.model) || base(models?.current) || '';
  const upFirst = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const footLabel = [
    upFirst(stateText(backend, t)),
    serving ? t('status.npuLine', { state: npuLine[0] }) : '',
    serving && lastStats?.tps ? t('stats.tps', { tps: lastStats.tps.toFixed(1) }) : '',
  ].filter(Boolean).join(' · ');
  const statusRows: Array<[string, string]> = [
    [t('status.backend'), backend.state === 'ready' && backend.port ? t('status.backendAt', { state: stateText(backend, t), port: backend.port }) : stateText(backend, t)],
    [t('status.model'), `${served || '-'}${backend.context ? `, ctx ${backend.context}` : ''}`],
    [t('status.npu'), npuLine.join(', ')],
    [t('status.speed'), lastStats ? statsText({ id: '', role: 'assistant', content: '', stats: lastStats }, t) : '-'],
  ];

  // ---- the model selector in the chatbot header

  const installed = models?.installed ?? [];
  const selectedPath = settings.model || '';
  const selectorLabel = modelName(selectedPath || served || models?.current || '') || t('bar.modelDefault');
  const onSelectModel = (_e: ReactMouseEvent | undefined, value: string | number | undefined) => {
    if (value === '__manage') { setDialog('models'); return; }
    if (generating) return;
    const v = String(value ?? '');
    if (v === selectedPath) return;
    useModel(v);
  };

  const welcome = [1, 2, 3].map((i) => ({
    title: t(`prompt.${i}.title`),
    message: t(`prompt.${i}.message`),
    onClick: () => send(t(`prompt.${i}.message`)),
  }));

  const msgs = current?.messages ?? [];
  const lastBot = msgs.length && msgs[msgs.length - 1].role === 'assistant' ? msgs.length - 1 : -1;

  const modelChoices = [
    { value: '', label: models?.current ? t('model.configDefault', { name: modelName(models.current) }) : t('bar.modelDefault') },
    ...installed.map((m) => ({ value: m.path, label: modelName(m.file) })),
  ];

  const canExport = !!current && current.messages.some((m) => m.content.trim()) && !generating;

  const openSettings = () => { setIsDrawerOpen(false); setAreSettingsOpen(true); };
  const closeSettings = () => {
    setAreSettingsOpen(false);
    window.requestAnimationFrame(() => settingsNavRef.current?.focus());
  };
  const startNewChat = () => {
    newConversation();
    setIsDrawerOpen(false);
    setAreSettingsOpen(false);
  };

  // ---- from here on, the Chatbot extension's "Fullscreen chatbot with
  // docked navigation" demo (patternfly-docs/content/extensions/chatbot/
  // examples/demos/FullscreenDockedNav.tsx, @patternfly/chatbot 6.9.0), with
  // this app's content. The demo's user avatar at the foot of the rail is
  // left out: this app has no user account to show.

  const dockedNav = (
    <>
      <style>{hamburgerHoverStyles}</style>
      <div className="pf-chatbot__canvas-docked-nav pf-v6-u-h-100 pf-v6-u-p-sm">
        <Masthead variant="docked">
          <MastheadMain>
            <MastheadToggle>
              <PageToggleButton
                className="pf-chatbot__canvas-history-toggle"
                aria-label={t('menu.history')}
                isHamburgerButton
                isSidebarOpen={isDrawerOpen}
                onSidebarToggle={() => setIsDrawerOpen((open) => !open)}
              />
            </MastheadToggle>
            <MastheadBrand>
              <MastheadLogo isCompact>
                <Brand src={botAvatar} alt={t('app.name')} heights={{ default: '37px' }} />
              </MastheadLogo>
            </MastheadBrand>
          </MastheadMain>
          <MastheadContent>
            <Divider />
            <Nav
              variant="docked"
              aria-label={t('menu.navigation')}
              className="pf-v6-u-flex-1 pf-v6-u-align-content-space-between"
            >
              <NavList>
                <NavItem
                  itemId="new-chat"
                  aria-label={t('conv.new')}
                  icon={<RhUiEditFillIcon />}
                  component="button"
                  preventDefault
                  anchorRef={newChatRef}
                  onClick={startNewChat}
                >
                  {t('conv.new')}
                </NavItem>
                <NavItem
                  itemId="export"
                  aria-label={t('export.current')}
                  icon={<RhUiExportFillIcon />}
                  component="button"
                  preventDefault
                  anchorRef={exportRef}
                  aria-disabled={!canExport}
                  onClick={() => { if (current && canExport) exportConv(current); }}
                >
                  {t('export.current')}
                </NavItem>
              </NavList>
              <NavList className="pf-v6-u-mt-auto">
                <NavItem
                  itemId="settings"
                  aria-label={t('menu.settings')}
                  icon={<RhUiSettingsFillIcon />}
                  component="button"
                  preventDefault
                  anchorRef={settingsNavRef}
                  onClick={openSettings}
                >
                  {t('menu.settings')}
                </NavItem>
              </NavList>
            </Nav>
            <Tooltip aria="none" aria-live="off" triggerRef={newChatRef} content={t('conv.new')} />
            <Tooltip aria="none" aria-live="off" triggerRef={exportRef} content={t('export.current')} />
            <Tooltip aria="none" aria-live="off" triggerRef={settingsNavRef} content={t('menu.settings')} />
          </MastheadContent>
        </Masthead>
      </div>
    </>
  );

  return (
    <>
      <Chatbot displayMode={ChatbotDisplayMode.fullscreen} dockedNav={dockedNav} ariaLabel={t('app.name')}>
        <div className="pf-chatbot__canvas">
          <ChatbotConversationHistoryNav
            displayMode={ChatbotDisplayMode.fullscreen}
            isDrawerOpen={isDrawerOpen}
            setIsDrawerOpen={setIsDrawerOpen}
            onDrawerToggle={() => { setIsDrawerOpen((open) => !open); setSearch(''); }}
            conversations={groups}
            activeItemId={currentId ?? undefined}
            onSelectActiveItem={(_e?: ReactMouseEvent, id?: string | number) => {
              if (!generating && id) { setCurrentId(String(id)); saveConvs(convsRef.current, String(id)); setIsDrawerOpen(false); setAreSettingsOpen(false); }
            }}
            onNewChat={startNewChat}
            drawerCloseButtonProps={{ 'aria-label': t('conv.closeHistory') }}
            title={t('menu.history')}
            newChatButtonText={t('conv.new')}
            newChatButtonProps={{ isDisabled: generating }}
            handleTextInputChange={(v: string) => setSearch(v)}
            searchInputPlaceholder={t('conv.search')}
            searchInputAriaLabel={t('conv.search')}
            emptyState={convs.length ? undefined : { titleText: t('conv.empty'), headingLevel: 'h4' }}
            noResultsState={convs.length && search.trim() && !Object.keys(groups).length
              ? { titleText: t('conv.noResults'), headingLevel: 'h4' } : undefined}
            drawerContent={
              <div className="pf-chatbot__canvas">
                {areSettingsOpen ? (
                  <SettingsPanel
                    settings={settings} setSettings={(s) => { settingsRef.current = s; setSettings(s); }}
                    models={modelChoices} model={selectedPath} onModel={(v) => onSelectModel(undefined, v)}
                    canRestart={!generating} onClose={closeSettings}
                    onManageModels={() => setDialog('models')} onAdvanced={() => setDialog('settings')}
                    onRestart={() => startBackend()} onReport={() => setDialog('log')} onAbout={() => setDialog('about')}
                  />
                ) : (
                  <div className="pf-chatbot__canvas-column">
                    <ChatbotContent>
                      <MessageBox
                        ariaLabel={t('chat.log')}
                        announcement={announcement}
                        position="bottom"
                        enableSmartScroll
                        ref={messageBoxRef}
                      >
                        {notices}
                        {(serving || !notices.length) && (
                          <ChatbotWelcomePrompt
                            title={t('welcome.title')}
                            description={serving ? t('welcome.description') : t('chat.emptyStopped')}
                            prompts={serving ? welcome : []}
                          />
                        )}
                        {msgs.map((m, i) => {
                          const pending = generating && i === msgs.length - 1 && m.role === 'assistant';
                          const meta = statsText(m, t);
                          return (
                            <Message
                              key={m.id}
                              id={m.id}
                              role={m.role === 'user' ? 'user' : 'bot'}
                              name={m.role === 'user' ? t('chat.you') : t('chat.assistant')}
                              avatar={m.role === 'user' ? userAvatar : undefined}
                              avatarProps={m.role === 'user' ? { isBordered: true } : undefined}
                              content={m.content}
                              isLoading={pending && !m.content}
                              loadingWord={t('chat.loadingWord')}
                              botWord={t('chat.botWord')}
                              timestamp={m.at ? new Date(m.at).toLocaleString(lang) : undefined}
                              openLinkInNewTab
                              codeBlockProps={{ 'aria-label': t('chat.copy') }}
                              error={m.error ? { title: t('chat.error', { msg: m.error }) } : undefined}
                              actions={m.role === 'assistant' && m.content && !pending ? {
                                copy: { onClick: () => { copyText(m.content); }, tooltipContent: t('chat.copy'), clickedTooltipContent: t('chat.copied'), ariaLabel: t('chat.copy') },
                                ...(i === lastBot && serving ? {
                                  regenerate: { onClick: regenerate, tooltipContent: t('chat.regenerate'), ariaLabel: t('chat.regenerate'), icon: <RedoIcon /> },
                                } : {}),
                              } : undefined}
                              extraContent={meta && !pending ? { afterMainContent: <Content component="small" className="msg-stats">{meta}</Content> } : undefined}
                            />
                          );
                        })}
                      </MessageBox>
                    </ChatbotContent>
                    <ChatbotFooter>
                      <MessageBar
                        onSendMessage={send}
                        hasAttachButton={false}
                        alwayShowSendButton
                        hasStopButton={generating}
                        handleStopButton={stop}
                        isSendButtonDisabled={generating || !serving}
                        placeholder={serving ? t('chat.placeholder') : t('chat.placeholderWait')}
                        buttonProps={{ send: { tooltipContent: t('chat.send') }, stop: { tooltipContent: t('chat.stop') } }}
                      />
                      <ChatbotFootnote
                        label={footLabel}
                        popover={{
                          title: t('menu.status'),
                          description: statusRows.map(([k, v]) => t('status.row', { k, v })).join('\n'),
                          showClose: true,
                        }}
                      />
                    </ChatbotFooter>
                  </div>
                )}
              </div>
            }
          />
        </div>
      </Chatbot>
      <AlertGroup isToast isLiveRegion>
        {toast && (
          <Alert variant={toast.variant} title={toast.title} timeout={toast.variant === 'success' ? 6000 : false}
            onTimeout={() => setToast(null)}
            actionClose={<AlertActionCloseButton title={toast.title} onClose={() => setToast(null)} />}>
            {toast.body && <p className="export-path">{toast.body}</p>}
          </Alert>
        )}
      </AlertGroup>
      {dialog === 'models' && (
        <ModelsModal models={models} error={modelsError} pull={pull} setPull={setPull} settings={settings} backend={backend}
          onRefresh={refreshModels} onUse={(p) => { useModel(p); setDialog(''); }} onClose={() => setDialog('')} />
      )}
      {dialog === 'settings' && (
        <SettingsModal settings={settings} info={info}
          onSave={(s) => {
            const pathChanged = s.charsiuPath !== settingsRef.current.charsiuPath;
            settingsRef.current = s;
            setSettings(s);
            setDialog('');
            if (pathChanged) { startBackend(); refreshModels(); }
          }}
          onClose={() => setDialog('')} />
      )}
      <AboutModal open={dialog === 'about'} info={info} onReport={() => setDialog('log')} onClose={() => setDialog('')} />
      {dialog === 'log' && (
        <LogModal info={info} backend={backend} npuLine={npuLine.join(', ')} model={served} onClose={() => setDialog('')} />
      )}
      {renaming && (
        <RenameModal value={titleOf(renaming, t)} onSave={(v) => {
          update((list) => list.map((c) => (c.id === renaming.id ? { ...c, title: v.trim().slice(0, 80) } : c)));
          setRenaming(null);
        }} onClose={() => setRenaming(null)} />
      )}
      {deleting && (
        <ConfirmDelete title={titleOf(deleting, t)} onDelete={() => {
          const id = deleting.id;
          const rest = convsRef.current.filter((c) => c.id !== id);
          const cur = currentIdRef.current === id ? rest[0]?.id ?? null : currentIdRef.current;
          setCurrentId(cur);
          update(() => rest, cur);
          setDeleting(null);
        }} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}
