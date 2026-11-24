// The page's language in a React context: Maskrom Studio's renderer/i18n.tsx
// (same author and licence). Here the choice lives in the app's settings
// (settings.language, '' = follow the system) rather than in localStorage,
// because the settings file is what the app keeps.
// SPDX-License-Identifier: GPL-2.0-only
import { createContext, useContext, useMemo } from 'react';
import { pickLang, translator, type Lang, type T } from './i18n-core';
import { MESSAGES } from './messages';

interface I18n { lang: Lang; t: T }

const system = (): readonly string[] => (typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []);

export function resolveLang(setting: string): Lang {
  return pickLang(setting || null, system());
}

const Ctx = createContext<I18n>({ lang: 'en', t: translator(MESSAGES, 'en') });

export function I18nProvider({ setting, children }: { setting: string; children: React.ReactNode }) {
  const lang = resolveLang(setting);
  const value = useMemo<I18n>(() => ({ lang, t: translator(MESSAGES, lang) }), [lang]);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = (): I18n => useContext(Ctx);
