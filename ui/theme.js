// SPDX-License-Identifier: GPL-2.0-only
// Before first paint: the theme the settings chose, kept in localStorage
// as a mirror so the window does not flash light. The settings file is the
// record; this is only a convenience.
'use strict';
(function () {
  let pref = 'system';
  try { pref = localStorage.getItem('charsiu.theme') || 'system'; } catch (e) { /* no storage */ }
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('pf-v6-theme-dark', dark);
})();
