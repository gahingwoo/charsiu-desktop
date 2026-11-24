// The dialogs. The About box and the settings as PatternFly form sections
// are Maskrom Studio's (src/renderer/common.tsx, same author and licence),
// with this app's rows and fields.
// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Button, CodeBlock, CodeBlockAction, CodeBlockCode, Content, Form, FormGroup, FormHelperText, FormSection, HelperText,
  HelperTextItem, Modal, ModalBody, ModalFooter, ModalHeader, Stack, TextArea, TextInput,
} from '@patternfly/react-core';
import { TimesIcon } from '@patternfly/react-icons/dist/esm/icons/times-icon';
import { copyText, DEFAULTS, invoke, openUrl, tauri, type Info, type Settings, type Snapshot } from './api';
import { useI18n } from './i18n';
import { issueUrl, scrubbedLog } from './report';

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DATE__: string;
declare const __PATTERNFLY_VERSION__: string;
declare const __CHATBOT_VERSION__: string;
export const BUILD = {
  commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
  date: typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '',
  patternfly: typeof __PATTERNFLY_VERSION__ === 'string' ? __PATTERNFLY_VERSION__ : '',
  chatbot: typeof __CHATBOT_VERSION__ === 'string' ? __CHATBOT_VERSION__ : '',
};

function CreditBadge() {
  return (
    <svg className="credit-badge" viewBox="14 0 346 110" role="img" aria-label="Engineered by gahingwoo">
      <g className="credit-badge__mark" transform="translate(14,19) scale(0.257143)">
        <rect x="0" y="0" width="350" height="70" />
        <rect x="70" y="70" width="70" height="70" />
        <rect x="210" y="70" width="70" height="70" />
        <rect x="0" y="210" width="350" height="70" />
      </g>
      <text className="credit-badge__label" x="124" y="48">Engineered by</text>
      <text className="credit-badge__name" x="123" y="88">gahingwoo</text>
    </svg>
  );
}

/**
 * About Charsiu Desktop: PatternFly's about modal box with the facts of this
 * build, laid out as Maskrom Studio's (and gahingwoo.com's "About this
 * site"), on a backdrop that covers the whole window and blurs it.
 */
export function AboutModal({ open, info, onReport, onClose }: { open: boolean; info: Info; onReport: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  if (!open) return null;
  const link = (href: string, text: string) => (
    <a href={href} onClick={(e) => { e.preventDefault(); openUrl(href); }}>{text}</a>
  );
  const rows: Array<[string, React.ReactNode]> = [
    [t('about.version'), t('about.version.value', { version: info.version || '0.3.0', commit: BUILD.commit, date: BUILD.date })],
    [t('about.design'), `PatternFly ${BUILD.patternfly}, PatternFly Chatbot ${BUILD.chatbot}`],
    [t('about.runtime'), t('about.runtime.value')],
    [t('about.charsiu'), <span className="selectable">{info.charsiu || '-'}</span>],
    [t('about.network'), t('about.network.value')],
    [t('about.kept'), t('about.kept.value')],
    [t('about.licence'), t('about.licence.value')],
    [t('about.madeBy'), link('https://gahingwoo.com', 'Ga Hing Woo (Jiaxing Hu)')],
    [t('about.source'), link('https://github.com/gahingwoo/charsiu-desktop', 'github.com/gahingwoo/charsiu-desktop')],
    [t('menu.report'), <Button variant="link" isInline onClick={onReport}>{t('report.title')}</Button>],
  ];
  return createPortal(
    <div className="pf-v6-c-backdrop about-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pf-v6-l-bullseye">
        <div className="pf-v6-c-about-modal-box" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <div className="pf-v6-c-about-modal-box__brand"><CreditBadge /></div>
          <div className="pf-v6-c-about-modal-box__close">
            <Button ref={close} variant="plain" aria-label={t('about.close')} icon={<TimesIcon />} onClick={onClose} />
          </div>
          <div className="pf-v6-c-about-modal-box__header">
            <h1 className="pf-v6-c-title pf-m-2xl" id="about-title">{t('about.title')}</h1>
          </div>
          <div className="pf-v6-c-about-modal-box__content">
            <dl className="pf-v6-c-description-list pf-m-horizontal">
              {rows.map(([k, v]) => (
                <div className="pf-v6-c-description-list__group" key={k}>
                  <dt className="pf-v6-c-description-list__term"><span className="pf-v6-c-description-list__text">{k}</span></dt>
                  <dd className="pf-v6-c-description-list__description"><div className="pf-v6-c-description-list__text">{v}</div></dd>
                </div>
              ))}
            </dl>
            <p className="pf-v6-c-about-modal-box__strapline">{t('about.strapline')}</p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Settings, as PatternFly form sections (Maskrom Studio's settings dialog). */
export function SettingsModal({ settings, info, onSave, onClose }: {
  settings: Settings; info: Info; onSave: (s: Settings) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [s, setS] = useState<Settings>(settings);
  const [temp, setTemp] = useState(String(settings.temperature));
  const [max, setMax] = useState(String(settings.maxTokens));
  const set = (p: Partial<Settings>) => setS((c) => ({ ...c, ...p }));
  const save = () => {
    const tv = Number(temp);
    const mv = Math.round(Number(max));
    onSave({
      ...s,
      temperature: Number.isFinite(tv) ? Math.min(2, Math.max(0, tv)) : DEFAULTS.temperature,
      maxTokens: Number.isFinite(mv) && mv > 0 ? Math.min(4096, mv) : DEFAULTS.maxTokens,
      charsiuPath: s.charsiuPath.trim(),
    });
  };
  return (
    <Modal isOpen variant="medium" onClose={onClose} aria-labelledby="settings-title" id="settings-dialog">
      <ModalHeader title={t('settings.advanced')} labelId="settings-title" />
      <ModalBody>
        <Form id="settings-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <FormSection title={t('settings.chat')} titleElement="h3">
            <FormGroup label={t('settings.temperature')} fieldId="set-temp">
              <TextInput id="set-temp" type="number" value={temp} onChange={(_e, v) => setTemp(v)} min={0} max={2} step={0.1} />
              <FormHelperText><HelperText><HelperTextItem>{t('settings.temperatureHelp')}</HelperTextItem></HelperText></FormHelperText>
            </FormGroup>
            <FormGroup label={t('settings.maxTokens')} fieldId="set-max">
              <TextInput id="set-max" type="number" value={max} onChange={(_e, v) => setMax(v)} min={1} max={4096} />
            </FormGroup>
            <FormGroup label={t('settings.system')} fieldId="set-system">
              <TextArea id="set-system" value={s.system} onChange={(_e, v) => set({ system: v })} rows={3} resizeOrientation="vertical" />
              <FormHelperText><HelperText><HelperTextItem>{t('settings.systemHelp')}</HelperTextItem></HelperText></FormHelperText>
            </FormGroup>
          </FormSection>
          <FormSection title={t('settings.runtime')} titleElement="h3">
            <FormGroup label={t('settings.charsiu')} fieldId="set-charsiu">
              <TextInput id="set-charsiu" value={s.charsiuPath} placeholder={info.charsiu || ''} onChange={(_e, v) => set({ charsiuPath: v })} />
              <FormHelperText><HelperText><HelperTextItem>
                {info.charsiu ? t('settings.charsiuHelp', { path: info.charsiu }) : t('settings.charsiuNone')}
              </HelperTextItem></HelperText></FormHelperText>
            </FormGroup>
          </FormSection>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" type="submit" form="settings-form">{t('settings.save')}</Button>
        <Button variant="link" onClick={onClose}>{t('settings.cancel')}</Button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * The backend log, and "Report a problem" from it: a GitHub issue opened
 * with the facts and the end of the log, scrubbed first (Maskrom Studio's
 * report flow).
 */
export function LogModal({ info, backend, npuLine, model, onClose }: {
  info: Info; backend: Snapshot; npuLine: string; model: string; onClose: () => void;
}) {
  const { t } = useI18n();
  const [lines, setLines] = useState<string[] | null>(null);
  const [what, setWhat] = useState('');
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!tauri()) { setLines([]); return; }
    invoke<string[]>('backend_log').then(setLines).catch((e) => setLines([String(e)]));
  }, []);
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [lines]);
  useEffect(() => {
    if (!copied) return undefined;
    const h = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(h);
  }, [copied]);
  const who = { home: info.home || '', user: info.user || '' };
  const log = lines ?? [];
  const facts = {
    version: info.version || '0.3.0', commit: BUILD.commit, os: info.os || 'unknown',
    backend: `${backend.state}${backend.problem ? ` (${backend.problem})` : ''}`, npu: npuLine, model: model || '-', what, log,
  };
  const actions = (
    <CodeBlockAction>
      <Button variant="link" aria-live="polite" onClick={() => { copyText(scrubbedLog(log, who)); setCopied(true); }}>
        {copied ? t('report.copied') : t('report.copy')}
      </Button>
    </CodeBlockAction>
  );
  return (
    <Modal isOpen variant="large" onClose={onClose} aria-labelledby="log-title" id="log-dialog">
      <ModalHeader title={t('report.title')} labelId="log-title" description={t('report.text')} />
      <ModalBody>
        <Stack hasGutter>
          <Form onSubmit={(e) => e.preventDefault()}>
            <FormGroup label={t('report.what')} fieldId="report-what">
              <TextArea id="report-what" value={what} onChange={(_e, v) => setWhat(v)} rows={2} resizeOrientation="vertical" />
              <FormHelperText><HelperText><HelperTextItem>{t('report.whatHelp')}</HelperTextItem></HelperText></FormHelperText>
            </FormGroup>
          </Form>
          <Content component="h3" className="regular">{t('log.title')}</Content>
          <CodeBlock actions={actions} className="log">
            <CodeBlockCode><span ref={(el) => { pre.current = el?.parentElement ?? null; }}>
              {lines === null ? '' : log.length ? scrubbedLog(log, who) : t('log.empty')}
            </span></CodeBlockCode>
          </CodeBlock>
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={() => openUrl(issueUrl(facts, who))}>{t('report.open')}</Button>
        <Button variant="link" onClick={onClose}>{t('common.close')}</Button>
      </ModalFooter>
    </Modal>
  );
}

export function RenameModal({ value, onSave, onClose }: { value: string; onSave: (v: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState(value);
  return (
    <Modal isOpen variant="small" onClose={onClose} aria-labelledby="rename-title">
      <ModalHeader title={t('conv.renameTitle')} labelId="rename-title" />
      <ModalBody>
        <Form id="rename-form" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSave(v); }}>
          <FormGroup label={t('conv.name')} fieldId="rename-input">
            <TextInput id="rename-input" value={v} onChange={(_e, x) => setV(x)} autoFocus />
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" type="submit" form="rename-form" isDisabled={!v.trim()}>{t('common.save')}</Button>
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
      </ModalFooter>
    </Modal>
  );
}

export function ConfirmDelete({ title, onDelete, onClose }: { title: string; onDelete: () => void; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal isOpen variant="small" onClose={onClose} aria-labelledby="delete-title">
      <ModalHeader title={t('conv.deleteAsk')} labelId="delete-title" titleIconVariant="warning" />
      <ModalBody>{t('conv.deleteBody', { title })}</ModalBody>
      <ModalFooter>
        <Button variant="danger" onClick={onDelete}>{t('common.delete')}</Button>
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
      </ModalFooter>
    </Modal>
  );
}
