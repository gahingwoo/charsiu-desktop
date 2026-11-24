// Screenshots of the built page (dist/) with scripts/mock-tauri.js standing
// in for the app, the way Maskrom Studio's scripts/shots.mjs takes its own:
// a local server, a real Chrome through playwright-core, light and dark.
//
//   node scripts/shots.mjs OUT_DIR        (CHROME=/path/to/chrome to choose one)
// SPDX-License-Identifier: GPL-2.0-only
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] || 'shots';
mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const mock = readFileSync('scripts/mock-tauri.js', 'utf8');

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join('dist', path === '/' ? 'index.html' : path);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const chrome = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: chrome, args: ['--font-render-hinting=none'] });
const errors = [];

async function shot(name, { scene = 'chat', lang = 'en', dark = false, then } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light', locale: lang });
  await ctx.addInitScript(mock);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: console: ${m.text()}`); });
  await page.goto(`${base}?scene=${scene}&lang=${lang}`);
  await page.waitForSelector('.pf-chatbot', { timeout: 15000 });
  await page.waitForTimeout(800);
  if (then) await then(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`${name}.png`);
  await ctx.close();
}

await shot('chat-light-en');
await shot('chat-dark-zh', { lang: 'zh-CN', dark: true });
await shot('welcome-light-zh', { scene: 'welcome', lang: 'zh-CN' });
await shot('history-light-en', {
  then: async (p) => { await p.click('.pf-chatbot__button--toggle-menu'); await p.waitForTimeout(600); },
});
await shot('models-dark-en', {
  dark: true,
  then: async (p) => { await p.getByRole('button', { name: 'Models' }).first().click(); await p.waitForTimeout(800); },
});
await shot('failed-light-en', { scene: 'failed' });

// Two questions in a row must both be answered: after the first reply Send
// stays available, even when a staging heartbeat arrives after "ready"
// (Charsiu Desktop 0.1.0 on the board kept Send disabled after one reply).
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(mock);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`two-prompts: ${e.message}`));
  await page.goto(`${base}?scene=welcome&lang=en&fast=1`);
  const box = page.locator('textarea');
  for (const [i, q] of ['First question', 'Second question'].entries()) {
    await box.waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    await box.fill(q);
    await box.press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.msg-stats').length >= n, i + 1, { timeout: 20000 })
      .catch(() => errors.push(`two-prompts: reply ${i + 1} never finished`));
  }
  const replies = await page.locator('.msg-stats').count();
  if (replies !== 2) errors.push(`two-prompts: ${replies} answered replies, expected 2`);
  await page.screenshot({ path: join(out, 'two-prompts-light-en.png') });
  console.log(`two-prompts-light-en.png (${replies} replies)`);
  await ctx.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
