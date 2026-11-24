// A conversation as a Markdown file: the title, the date, then each turn
// as a "**You:**" or "**Assistant:**" block with the text as it was written,
// code fences and all. Everything stays on this computer: the page builds
// the text, the Rust side asks where to save it and writes it there.
// SPDX-License-Identifier: GPL-2.0-only
import type { Conv } from './api';

export interface ExportWords {
  /** the title for a conversation that has none */
  untitled: string;
  /** "You", "Assistant" */
  you: string;
  assistant: string;
  /** what follows a label: ":" or the full-width "：" */
  colon: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as YYYY-MM-DD HH:MM, local time. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A reply stopped in the middle of a code block would swallow every turn after it: close the fence. */
export function closeFences(text: string): string {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (open === null) open = m[1];
    else if (m[1][0] === open[0] && m[1].length >= open.length && line.trim() === m[1]) open = null;
  }
  return open === null ? text : `${text.replace(/\n*$/, '')}\n${open}`;
}

export function toMarkdown(c: Conv, w: ExportWords): string {
  const title = (c.title || w.untitled).replace(/\s+/g, ' ').trim();
  const out = [`# ${title}`, '', stamp(c.created || c.updated || Date.now())];
  for (const m of c.messages) {
    const text = m.content.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (!text) continue;
    out.push('', `**${m.role === 'user' ? w.you : w.assistant}${w.colon}**`, '', closeFences(text));
  }
  return `${out.join('\n')}\n`;
}

/** A file name from the title: no characters Windows or Linux refuse, not too long, ending in .md. */
export function fileName(title: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const s = title.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80).trim();
  return `${s || fallback}.md`;
}
