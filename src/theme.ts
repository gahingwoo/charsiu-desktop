// Theme, as Maskrom Studio's renderer/theme.ts (same author and licence):
// light, dark, or the system's, as the class pf-v6-theme-dark on <html>.
// The choice is the app's setting; it is mirrored into localStorage.theme so
// theme.js can apply it before the first paint.
// SPDX-License-Identifier: GPL-2.0-only
export type Theme = 'system' | 'light' | 'dark';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t);
  } catch { /* no storage */ }
  const dark = t === 'dark' || (t === 'system' && media().matches);
  document.documentElement.classList.toggle('pf-v6-theme-dark', dark);
}

/** Follow the system while the setting says so; returns the unsubscribe. */
export function followSystem(current: () => Theme): () => void {
  const m = media();
  const on = () => { if (current() === 'system') applyTheme('system'); };
  m.addEventListener('change', on);
  return () => m.removeEventListener('change', on);
}
