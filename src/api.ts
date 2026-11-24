// The Rust side, as the page sees it. Everything that touches the system
// (the charsiu process, HTTP, files, the NPU) is a Tauri command in
// src-tauri/src/lib.rs; the shapes here mirror its serde types.
// SPDX-License-Identifier: GPL-2.0-only

export interface Snapshot {
  /** stopped, starting, loading, ready, failed */
  state: 'stopped' | 'starting' | 'loading' | 'ready' | 'failed';
  port?: number | null;
  model?: string | null;
  served?: string | null;
  context?: number | null;
  staged?: number | null;
  total?: number | null;
  /** unknown, on, off */
  npu: 'unknown' | 'on' | 'off';
  devices?: number | null;
  /** why the NPU is not used: admin, driver */
  npuProblem?: string | null;
  /** not_installed, no_model, model_missing, not_built, exited, spawn */
  problem?: string | null;
  detail?: string | null;
}

export type ChatEvent =
  | { kind: 'sent' }
  | { kind: 'token'; text: string }
  | { kind: 'done'; finish: string }
  | { kind: 'error'; message: string };

export interface ZooRow { name: string; repo: string; file: string; mmproj: string; mb: number; totalMb: number; note: string; installed: boolean }
export interface Installed { file: string; path: string; bytes: number; system: boolean }
export interface Models { dir: string; sysdir?: string | null; current?: string | null; zoo: ZooRow[]; installed: Installed[] }
export interface PullStatus { name: string; state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled' | string; bytes: number; total: number; message?: string | null }
export interface Core { name: string; state?: string | null; busy?: number | null; jobsPerSec?: number | null }
export interface NpuStatus {
  platform: 'windows' | 'linux' | string;
  device: string;
  problem?: number | null;
  driverLoaded?: boolean | null;
  cores: Core[];
  counters: string;
  bufferBytes?: number | null;
  rail?: string | null;
}
export interface Info { os: string; version: string; charsiu: string; home?: string; user?: string }

export interface Settings {
  temperature: number;
  maxTokens: number;
  system: string;
  /** '' follows the system */
  language: string;
  theme: 'system' | 'light' | 'dark';
  charsiuPath: string;
  /** a model path, '' = what charsiu's config names */
  model: string;
}

export const DEFAULTS: Settings = {
  temperature: 0, maxTokens: 512, system: '', language: '', theme: 'system', charsiuPath: '', model: '',
};

export interface Stats { tokens: number; ttft: number | null; tps: number | null; finish: string }
export interface Msg { id: string; role: 'user' | 'assistant'; content: string; stats?: Stats | null; error?: string; at?: number }
export interface Conv { id: string; title: string; created: number; updated: number; messages: Msg[] }

interface TauriChannel<T> { onmessage: (m: T) => void }
interface TauriGlobal {
  core: { invoke<R>(cmd: string, args?: Record<string, unknown>): Promise<R>; Channel: new <T>() => TauriChannel<T> };
  event: { listen<T>(name: string, cb: (e: { payload: T }) => void): Promise<() => void> };
}

declare global {
  interface Window { __TAURI__?: TauriGlobal }
}

export const tauri = (): TauriGlobal | null => window.__TAURI__ ?? null;

export function invoke<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  const t = tauri();
  if (!t) return Promise.reject(new Error('not inside Charsiu Desktop'));
  return t.core.invoke<R>(cmd, args);
}

export function channel<T>(on: (m: T) => void): TauriChannel<T> {
  const t = tauri();
  if (!t) throw new Error('not inside Charsiu Desktop');
  const ch = new t.core.Channel<T>();
  ch.onmessage = on;
  return ch;
}

export const INSTALL = {
  windows: 'irm https://raw.githubusercontent.com/gahingwoo/woa-rk3576-npu/main/win/charsiu-install.ps1 | iex',
  linux: 'curl -fsSL https://raw.githubusercontent.com/gahingwoo/charsiu/stable/scripts/charsiu-install.sh | sh',
  armbian: 'sudo apt install charsiu',
};

export const base = (p: string | null | undefined): string => String(p || '').split(/[\\/]/).pop() || '';

export function size(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  return `${Math.round(bytes / 1048576)} MB`;
}

export const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** The clipboard, with the old textarea trick where the web view refuses it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function openUrl(url: string): void {
  if (tauri()) invoke('open_url', { url }).catch(() => {});
  else window.open(url, '_blank', 'noopener');
}
