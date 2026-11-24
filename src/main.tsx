// SPDX-License-Identifier: GPL-2.0-only
import '@patternfly/react-core/dist/styles/base.css';
import '@patternfly/patternfly/patternfly-addons.css';
import '@patternfly/chatbot/dist/css/main.css';
import './app.css';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DEFAULTS, invoke, tauri, type Settings } from './api';
import { I18nProvider } from './i18n';
import { applyTheme } from './theme';

// Ctrl+A (Cmd+A) selects the text of the field it is typed in, never the
// whole window (Maskrom Studio's rule).
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
    const el = e.target as HTMLElement | null;
    const editable = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (!editable) e.preventDefault();
  }
}, true);

function Root() {
  const [settings, setState] = useState<Settings | null>(null);
  useEffect(() => {
    (async () => {
      let s: Settings = { ...DEFAULTS };
      if (tauri()) {
        try {
          const d = await invoke<{ settings?: Partial<Settings> }>('load_data');
          if (d.settings && typeof d.settings === 'object') s = { ...DEFAULTS, ...d.settings };
        } catch (e) { console.error('load_data', e); }
      }
      applyTheme(s.theme);
      setState(s);
    })();
  }, []);
  const setSettings = useCallback((s: Settings) => {
    setState(s);
    if (tauri()) invoke('save_settings', { value: s }).catch((e) => console.error('save_settings', e));
  }, []);
  if (!settings) return null;
  return <I18nProvider setting={settings.language}><App settings={settings} setSettings={setSettings} /></I18nProvider>;
}

createRoot(document.getElementById('root')!).render(<Root />);
