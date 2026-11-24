// Charsiu Desktop, the page: PatternFly's Chatbot in embedded display mode
// under the masthead Maskrom Studio uses, laid out as the Chatbot
// extension's "Embedded chatbot" demo. Everything that touches the system is
// a Rust command (src/api.ts); this keeps the conversations and draws.
// SPDX-License-Identifier: GPL-2.0-only
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Alert, AlertActionLink, Button, CodeBlock, CodeBlockCode, Content, Divider, DropdownGroup, DropdownItem, DropdownList,
  Masthead, MastheadBrand, MastheadContent, MastheadLogo, MastheadMain, Page, Progress, ProgressSize, Spinner,
  Toolbar, ToolbarContent, ToolbarGroup, ToolbarItem,
} from '@patternfly/react-core';
import { CogIcon } from '@patternfly/react-icons/dist/esm/icons/cog-icon';
import { GlobeIcon } from '@patternfly/react-icons/dist/esm/icons/globe-icon';
import { RedoIcon } from '@patternfly/react-icons/dist/esm/icons/redo-icon';
import Chatbot, { ChatbotDisplayMode } from '@patternfly/chatbot/dist/dynamic/Chatbot';
import ChatbotContent from '@patternfly/chatbot/dist/dynamic/ChatbotContent';
import ChatbotWelcomePrompt from '@patternfly/chatbot/dist/dynamic/ChatbotWelcomePrompt';
import ChatbotFooter, { ChatbotFootnote } from '@patternfly/chatbot/dist/dynamic/ChatbotFooter';
import MessageBar from '@patternfly/chatbot/dist/dynamic/MessageBar';
import MessageBox from '@patternfly/chatbot/dist/dynamic/MessageBox';
import Message from '@patternfly/chatbot/dist/dynamic/Message';
import ChatbotConversationHistoryNav, { type Conversation } from '@patternfly/chatbot/dist/dynamic/ChatbotConversationHistoryNav';
import ChatbotHeader, {
  ChatbotHeaderActions, ChatbotHeaderMain, ChatbotHeaderMenu, ChatbotHeaderOptionsDropdown, ChatbotHeaderSelectorDropdown,
  ChatbotHeaderTitle,
} from '@patternfly/chatbot/dist/dynamic/ChatbotHeader';
import {
  base, channel, DEFAULTS, INSTALL, invoke, tauri, uid, copyText,
  type ChatEvent, type Conv, type Info, type Models, type Msg, type NpuStatus, type PullStatus, type Settings, type Snapshot,
} from './api';
import { useI18n } from './i18n';
import { LANG_NAMES } from './i18n-core';
import type { T } from './i18n-core';
import { applyTheme, followSystem } from './theme';
import { AboutModal, ConfirmDelete, LangModal, LogModal, RenameModal, SettingsModal } from './dialogs';
import { ModelsModal } from './models';
import botAvatar from '../src-tauri/icons/128x128.png';
import userAvatar from './user-avatar.svg';

const DISPLAY = ChatbotDisplayMode.embedded;

// ---- words for the state ---------------------------------------------------------

export function stateText(b: Snapshot, t: T): string {
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
  const [generating, setGenerating] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<'' | 'models' | 'settings' | 'lang' | 'about' | 'log'>('');
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
    setDrawer(false);
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
    } catch (e) {
      finish('error', String(e));
    }
  };

  const send = (raw: string | number) => {
    const text = String(raw).trim();
    if (!text || generating || backend.state !== 'ready' || !tauri()) return;
    const c = ensureConversation();
    const user: Msg = { id: uid(), role: 'user', content: text, at: Date.now() };
    const conv = convsRef.current.find((x) => x.id === c.id) ?? c;
    ask(conv, [...conv.messages, user]);
  };

  const stop = () => { if (tauri()) invoke('chat_cancel').catch(() => {}); };

  const regenerate = () => {
    if (!current || generating || backend.state !== 'ready') return;
    const ms = current.messages;
    let end = ms.length;
    while (end > 0 && ms[end - 1].role === 'assistant') end -= 1;
    if (end === 0) return;
    ask(current, ms.slice(0, end));
  };

  const clearConversation = () => {
    if (!current || generating) return;
    update((list) => list.map((c) => (c.id === current.id ? { ...c, messages: [], title: '', updated: Date.now() } : c)));
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

  const win = info.os === 'windows';
  const notices: React.ReactNode[] = [];
  const code = (s: string) => <CodeBlock key={s}><CodeBlockCode>{s}</CodeBlockCode></CodeBlock>;
  if (loaded && !tauri()) {
    notices.push(<Alert key="browser" isInline variant="danger" title={t('problem.browser')} />);
  } else if (backend.state === 'failed') {
    const retry = <AlertActionLink key="retry" onClick={() => startBackend()}>{t('common.retry')}</AlertActionLink>;
    const log = <AlertActionLink key="log" onClick={() => setDialog('log')}>{t('common.showLog')}</AlertActionLink>;
    const open = <AlertActionLink key="models" onClick={() => setDialog('models')}>{t('problem.openModels')}</AlertActionLink>;
    switch (backend.problem) {
      case 'not_installed':
        notices.push(
          <Alert key="p" isInline variant="danger" title={t('problem.notInstalled')}
            actionLinks={[retry, <AlertActionLink key="set" onClick={() => setDialog('settings')}>{t('problem.setPath')}</AlertActionLink>]}>
            <p>{t(win ? 'problem.notInstalledWin' : 'problem.notInstalledLinux')}</p>
            {win ? code(INSTALL.windows) : <>{code(INSTALL.armbian)}{code(INSTALL.linux)}</>}
          </Alert>,
        );
        break;
      case 'no_model':
        notices.push(<Alert key="p" isInline variant="warning" title={t('problem.noModel')} actionLinks={[open, retry]}><p>{t('problem.noModelBody')}</p></Alert>);
        break;
      case 'model_missing':
        notices.push(<Alert key="p" isInline variant="warning" title={t('problem.modelMissing')} actionLinks={[open, retry]}><p>{t('problem.modelMissingBody')}</p></Alert>);
        break;
      case 'not_built':
        notices.push(
          <Alert key="p" isInline variant="danger" title={t('problem.notBuilt')} actionLinks={[retry, log]}>
            <p>{t('problem.notBuiltBody')}</p>{code(win ? INSTALL.windows : INSTALL.linux)}
          </Alert>,
        );
        break;
      default:
        notices.push(
          <Alert key="p" isInline variant="danger" title={t(backend.problem === 'spawn' ? 'problem.spawn' : 'problem.exited')} actionLinks={[retry, log]}>
            {backend.detail && <p className="selectable mono">{backend.detail}</p>}
          </Alert>,
        );
    }
  } else if (backend.state === 'ready' || backend.state === 'loading') {
    if (backend.npuProblem === 'admin') {
      notices.push(<Alert key="n" isInline variant="warning" title={t('problem.adminNeeded')}><p>{t('problem.adminNeededBody')}</p>{code(INSTALL.windows)}</Alert>);
    } else if (backend.npuProblem === 'driver' || (backend.npu === 'off' && win && backend.state === 'ready')) {
      notices.push(
        <Alert key="n" isInline variant="warning" title={t('problem.driverWin')}
          actionLinks={[<AlertActionLink key="log" onClick={() => setDialog('log')}>{t('common.showLog')}</AlertActionLink>]}>
          <p>{t('problem.driverWinBody')}</p>{code(INSTALL.windows)}
        </Alert>,
      );
    } else if (backend.npu === 'off' && !win && backend.state === 'ready') {
      notices.push(
        <Alert key="n" isInline variant="warning" title={t('problem.cpuLinux')}
          actionLinks={[<AlertActionLink key="log" onClick={() => setDialog('log')}>{t('common.showLog')}</AlertActionLink>]}>
          <p>{t('problem.cpuLinuxBody')}</p>{code(INSTALL.linux)}
        </Alert>,
      );
    }
  }

  // ---- the footnote: the status, as words, with the details a click away

  const lastStats = useMemo(() => {
    for (const c of convs) for (let i = c.messages.length - 1; i >= 0; i--) {
      const s = c.messages[i].stats;
      if (s && s.tps) return s;
    }
    return null;
  }, [convs]);
  const npuLine = npuWords(backend, npu, t);
  const served = backend.served || base(backend.model) || base(models?.current) || '';
  const footLabel = [
    stateText(backend, t),
    backend.state === 'ready' || backend.state === 'loading' ? t('status.npuLine', { state: npuLine[0] }) : '',
    lastStats?.tps ? t('stats.tps', { tps: lastStats.tps.toFixed(1) }) : '',
    lastStats?.ttft != null ? t('stats.ttft', { s: (lastStats.ttft / 1000).toFixed(2) }) : '',
  ].filter(Boolean).join(' · ');
  const footDetail = [
    `${t('status.backend')}: ${backend.state === 'ready' && backend.port ? t('status.backendAt', { state: stateText(backend, t), port: backend.port }) : stateText(backend, t)}`,
    `${t('status.model')}: ${served || '-'}${backend.context ? `, ctx ${backend.context}` : ''}`,
    `${t('status.npu')}: ${npuLine.join(', ')}`,
    `${t('status.speed')}: ${lastStats ? statsText({ id: '', role: 'assistant', content: '', stats: lastStats }, t) : '-'}`,
  ].join('\n');

  // ---- the model selector in the chatbot header

  const installed = models?.installed ?? [];
  const selectedPath = settings.model || '';
  const selectorLabel = selectedPath ? base(selectedPath) : (served || base(models?.current) || t('bar.modelDefault'));
  const onSelectModel = (_e: ReactMouseEvent | undefined, value: string | number | undefined) => {
    if (value === '__manage') { setDialog('models'); return; }
    if (generating) return;
    const v = String(value ?? '');
    if (v === selectedPath) return;
    useModel(v);
  };

  const onOption = (_e: ReactMouseEvent | undefined, value: string | number | undefined) => {
    switch (value) {
      case 'models': setDialog('models'); break;
      case 'settings': setDialog('settings'); break;
      case 'lang': setDialog('lang'); break;
      case 'log': setDialog('log'); break;
      case 'about': setDialog('about'); break;
      case 'clear': clearConversation(); break;
      case 'restart': startBackend(); break;
      default:
    }
  };

  const welcome = [1, 2, 3].map((i) => ({
    title: t(`prompt.${i}.title`),
    message: t(`prompt.${i}.message`),
    onClick: () => send(t(`prompt.${i}.message`)),
  }));

  const msgs = current?.messages ?? [];
  const lastBot = msgs.length && msgs[msgs.length - 1].role === 'assistant' ? msgs.length - 1 : -1;
  const loadingProgress = backend.state === 'loading' && backend.total
    ? Math.min(100, Math.round((100 * (backend.staged || 0)) / backend.total)) : null;

  const masthead = (
    <Masthead display={{ default: 'inline' }}>
      <MastheadMain>
        <MastheadBrand>
          <MastheadLogo component="span" className="brand">
            <img src={botAvatar} alt="" className="brand-mark" />
            <span className="brand-name">{t('app.name')}</span>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            <ToolbarGroup align={{ default: 'alignEnd' }}>
              <ToolbarItem>
                <Button variant="plain" onClick={() => setDialog('models')}>{t('menu.models')}</Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="plain" icon={<GlobeIcon />} aria-label={t('lang.dialog')} title={t('lang.dialog')} onClick={() => setDialog('lang')}>
                  <span lang={lang}>{LANG_NAMES[lang]}</span>
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="plain" icon={<CogIcon />} onClick={() => setDialog('settings')}>{t('menu.settings')}</Button>
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );

  return (
    <Page masthead={masthead} isContentFilled>
      <Chatbot displayMode={DISPLAY} ariaLabel={t('app.name')}>
        <ChatbotConversationHistoryNav
          displayMode={DISPLAY}
          onDrawerToggle={() => setDrawer(!drawer)}
          isDrawerOpen={drawer}
          setIsDrawerOpen={setDrawer}
          activeItemId={currentId ?? undefined}
          onSelectActiveItem={(_e?: ReactMouseEvent, id?: string | number) => { if (!generating && id) { setCurrentId(String(id)); saveConvs(convsRef.current, String(id)); setDrawer(false); } }}
          conversations={groups}
          title={t('menu.history')}
          newChatButtonText={t('conv.new')}
          newChatButtonProps={{ isDisabled: generating }}
          onNewChat={newConversation}
          searchInputPlaceholder={t('conv.search')}
          searchInputAriaLabel={t('conv.search')}
          handleTextInputChange={(v: string) => setSearch(v)}
          emptyState={convs.length ? undefined : { titleText: t('conv.empty'), headingLevel: 'h4' }}
          noResultsState={convs.length && search.trim() && !Object.keys(groups).length
            ? { titleText: t('conv.noResults'), headingLevel: 'h4' } : undefined}
          drawerContent={
            <>
              <ChatbotHeader>
                <ChatbotHeaderMain>
                  <ChatbotHeaderMenu aria-expanded={drawer} onMenuToggle={() => setDrawer(!drawer)}
                    tooltipContent={t('menu.history')} menuAriaLabel={t('menu.history')} />
                  <ChatbotHeaderTitle>
                    <span className="conv-title" title={current ? titleOf(current, t) : t('conv.untitled')}>
                      {current ? titleOf(current, t) : t('conv.untitled')}
                    </span>
                  </ChatbotHeaderTitle>
                </ChatbotHeaderMain>
                <ChatbotHeaderActions>
                  <ChatbotHeaderSelectorDropdown value={selectorLabel} onSelect={onSelectModel}
                    menuToggleAriaLabel={t('model.label')} tooltipContent={t('model.label')}>
                    <DropdownList>
                      <DropdownItem value="" key="default" isSelected={!selectedPath}
                        description={models?.current ? base(models.current) : undefined}>{t('bar.modelDefault')}</DropdownItem>
                      {installed.map((m) => (
                        <DropdownItem value={m.path} key={m.path} isSelected={selectedPath === m.path}
                          description={models?.current === m.path ? t('models.configured') : undefined}>{m.file}</DropdownItem>
                      ))}
                    </DropdownList>
                    <Divider component="li" />
                    <DropdownList>
                      <DropdownItem value="__manage" key="manage">{t('menu.manageModels')}</DropdownItem>
                    </DropdownList>
                  </ChatbotHeaderSelectorDropdown>
                  <ChatbotHeaderOptionsDropdown onSelect={onOption} menuToggleAriaLabel={t('menu.options')}
                    tooltipProps={{ content: t('menu.options') }}>
                    <DropdownGroup>
                      <DropdownList>
                        <DropdownItem value="clear" key="clear" isDisabled={!current || !msgs.length || generating}>{t('menu.clear')}</DropdownItem>
                        <DropdownItem value="restart" key="restart" isDisabled={generating}>{t('menu.restart')}</DropdownItem>
                      </DropdownList>
                    </DropdownGroup>
                    <Divider component="li" />
                    <DropdownGroup>
                      <DropdownList>
                        <DropdownItem value="models" key="models">{t('menu.models')}</DropdownItem>
                        <DropdownItem value="settings" key="settings">{t('menu.settings')}</DropdownItem>
                        <DropdownItem value="lang" key="lang">{t('menu.language')}</DropdownItem>
                      </DropdownList>
                    </DropdownGroup>
                    <Divider component="li" />
                    <DropdownGroup>
                      <DropdownList>
                        <DropdownItem value="log" key="log">{t('menu.report')}</DropdownItem>
                        <DropdownItem value="about" key="about">{t('menu.about')}</DropdownItem>
                      </DropdownList>
                    </DropdownGroup>
                  </ChatbotHeaderOptionsDropdown>
                </ChatbotHeaderActions>
              </ChatbotHeader>
              <ChatbotContent>
                <MessageBox announcement={announcement} enableSmartScroll>
                  {notices.length > 0 && <div className="notices" aria-live="polite">{notices}</div>}
                  {!msgs.length && (
                    <>
                      <ChatbotWelcomePrompt title={t('welcome.title')} description={
                        backend.state === 'ready' ? t('welcome.description')
                          : backend.state === 'starting' || backend.state === 'loading' ? t('chat.emptyLoading') : t('chat.emptyStopped')}
                        prompts={backend.state === 'ready' ? welcome : []} />
                      {(backend.state === 'starting' || backend.state === 'loading') && (
                        <div className="loading">
                          {loadingProgress != null
                            ? <Progress value={loadingProgress} title={stateText(backend, t)} size={ProgressSize.sm} />
                            : <Content component="p"><Spinner size="md" aria-hidden /> {stateText(backend, t)}</Content>}
                        </div>
                      )}
                    </>
                  )}
                  {msgs.map((m, i) => {
                    const pending = generating && i === msgs.length - 1 && m.role === 'assistant';
                    const meta = statsText(m, t);
                    return (
                      <Fragment key={m.id}>
                        <Message
                          id={m.id}
                          role={m.role === 'user' ? 'user' : 'bot'}
                          name={m.role === 'user' ? t('chat.you') : t('chat.assistant')}
                          avatar={m.role === 'user' ? userAvatar : botAvatar}
                          avatarProps={m.role === 'user' ? { isBordered: true } : undefined}
                          content={m.content}
                          isLoading={pending && !m.content}
                          loadingWord={t('chat.loadingWord')}
                          botWord={t('chat.assistant')}
                          timestamp={m.at ? new Date(m.at).toLocaleString(lang) : undefined}
                          openLinkInNewTab
                          codeBlockProps={{ 'aria-label': t('chat.copy') }}
                          error={m.error ? { title: t('chat.error', { msg: m.error }) } : undefined}
                          actions={m.role === 'assistant' && m.content && !pending ? {
                            copy: { onClick: () => { copyText(m.content); }, tooltipContent: t('chat.copy'), clickedTooltipContent: t('chat.copied'), ariaLabel: t('chat.copy') },
                            ...(i === lastBot && backend.state === 'ready' ? {
                              regenerate: { onClick: regenerate, tooltipContent: t('chat.regenerate'), ariaLabel: t('chat.regenerate'), icon: <RedoIcon /> },
                            } : {}),
                          } : undefined}
                          extraContent={meta && !pending ? { afterMainContent: <div className="msg-stats">{meta}</div> } : undefined}
                        />
                      </Fragment>
                    );
                  })}
                </MessageBox>
              </ChatbotContent>
              <ChatbotFooter>
                <MessageBar
                  onSendMessage={send}
                  hasStopButton={generating}
                  handleStopButton={stop}
                  isSendButtonDisabled={generating || backend.state !== 'ready'}
                  placeholder={backend.state === 'ready' ? t('chat.placeholder') : t('chat.placeholderWait')}
                  buttonProps={{ send: { tooltipContent: t('chat.send') }, stop: { tooltipContent: t('chat.stop') } }}
                />
                <ChatbotFootnote label={footLabel} popover={{ title: t('footnote.title'), description: footDetail, popoverProps: { className: 'status-popover' } }} />
              </ChatbotFooter>
            </>
          }
        />
      </Chatbot>
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
          onAbout={() => setDialog('about')} onClose={() => setDialog('')} />
      )}
      {dialog === 'lang' && (
        <LangModal value={settings.language} onSelect={(l) => { setSettings({ ...settingsRef.current, language: l }); setDialog(''); }} onClose={() => setDialog('')} />
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
    </Page>
  );
}
