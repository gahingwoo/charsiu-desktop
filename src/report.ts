// "Report a problem": a GitHub issue opened with its title and body filled
// in. What leaves the computer is scrubbed first. The scrubbing is Maskrom
// Studio's (src/shared/report.ts, same author and licence), unchanged; the
// report's facts are this app's.
// SPDX-License-Identifier: GPL-2.0-only

export const ISSUES_NEW = 'https://github.com/gahingwoo/charsiu-desktop/issues/new';
/** GitHub refuses longer links; the log is cut from the front to fit. */
export const MAX_URL = 8000;

export interface Who {
  /** The home folder as the OS has it (/home/ann, /Users/ann, C:\Users\ann). */
  home: string;
  user: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function scrub(text: string, who: Who): string {
  let out = text;
  if (who.home && who.home.length > 1) {
    // As written, and with the other slash (logs mix them on Windows).
    for (const h of new Set([who.home, who.home.replace(/\\/g, '/'), who.home.replace(/\//g, '\\')])) {
      out = out.replace(new RegExp(escape(h), 'gi'), '~');
    }
  }
  out = out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    // An IPv4 address, not a four-part version number ("version 10.0.22631.2428", "v1.0.0.135").
    .replace(/(?<![\w.])(?<!version |v)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/gi, '<ip>')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<ip>')
    .replace(/(serial(?:\s*number)?["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1<serial>')
    .replace(/(app:\/\/local\/file\/)[A-Za-z0-9_-]+/g, '$1<token>')
    .replace(/((?:token|password|passwd|secret|key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1<removed>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<removed>');
  if (who.user && who.user.length >= 3 && !/^(root|user|admin|test)$/i.test(who.user)) {
    out = out.replace(new RegExp(`\\b${escape(who.user)}\\b`, 'gi'), '<user>');
  }
  return out;
}

export interface ReportFacts {
  version: string;
  commit: string;
  os: string;
  backend: string;
  npu: string;
  model: string;
  what: string;
  log: string[];
}

function body(f: ReportFacts, lines: string[], who: Who): string {
  const s = (x: string) => scrub(x, who);
  return [
    '## What happened',
    '',
    f.what ? s(f.what) : '<!-- What you did and what you expected. -->',
    '',
    '## Details',
    '',
    `- Charsiu Desktop ${f.version} (${f.commit})`,
    `- ${f.os}`,
    `- Backend: ${s(f.backend)}`,
    `- NPU: ${s(f.npu)}`,
    `- Model: ${s(f.model)}`,
    '',
    `## Backend log (${lines.length === f.log.length ? 'all' : `last ${lines.length}`} lines)`,
    '',
    '```',
    ...lines.map(s),
    '```',
    '',
  ].join('\n');
}

/** The link to a new issue, its log cut from the front until it fits MAX_URL. */
export function issueUrl(f: ReportFacts, who: Who): string {
  const title = `Problem (${f.os}, ${f.backend})`;
  for (let n = Math.min(80, f.log.length); ; n = n > 10 ? n - 10 : n - 1) {
    const lines = n > 0 ? f.log.slice(-n) : [];
    const url = `${ISSUES_NEW}?${new URLSearchParams({ title, body: body(f, lines, who) }).toString()}`;
    if (url.length <= MAX_URL || n <= 0) return url.length <= MAX_URL ? url : `${ISSUES_NEW}?${new URLSearchParams({ title }).toString()}`;
  }
}

/** The whole log, scrubbed, for the clipboard. */
export function scrubbedLog(log: string[], who: Who): string {
  return log.map((l) => scrub(l, who)).join('\n');
}
