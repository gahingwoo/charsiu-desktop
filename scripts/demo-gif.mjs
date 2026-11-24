// The README's animated walkthrough: the built page (dist/) with
// scripts/mock-tauri.js standing in for the app and its backend (fake
// streamed tokens, no model), driven through a real Chrome by
// playwright-core. Frames come from Chrome's screencast (CDP), ffmpeg turns
// them into a GIF with one palette per GIF.
//
//   node scripts/demo-gif.mjs [OUT_DIR]   (default docs/demo; CHROME=, FFMPEG= to choose)
//
// Writes demo-en.gif and demo-zh-CN.gif, light theme, 960 px wide.
// SPDX-License-Identifier: GPL-2.0-only
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] || 'docs/demo';
mkdirSync(out, { recursive: true });
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
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

// Headless Chrome draws no pointer; this one follows the mouse so a viewer
// can see what gets clicked.
const cursor = `addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:-40px;top:-40px;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .08s';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 9-6.2 1.1L14 19l-2.6 1.2-3.1-6.9L3 17z" fill="#151515" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.left = e.clientX - 3 + 'px'; c.style.top = e.clientY - 2 + 'px'; }, true);
  addEventListener('mousedown', () => { c.style.transform = 'scale(.8)'; }, true);
  addEventListener('mouseup', () => { c.style.transform = ''; }, true);
});`;

const question = { en: 'What is an NPU? And write a Python function that reverses a string.', 'zh-CN': '什么是 NPU？再写一个反转字符串的 Python 函数。' };

async function record(lang) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', locale: lang });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(cursor);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });

  await page.goto(`${base}?scene=welcome&lang=${lang}&demo=1`);
  await page.waitForSelector('.pf-chatbot', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

  let x = 640, y = 400;
  await page.mouse.move(x, y);
  const goto = async (loc) => {
    const b = await loc.boundingBox();
    if (!b) throw new Error('not on screen');
    const nx = b.x + b.width / 2, ny = b.y + b.height / 2;
    await page.mouse.move(nx, ny, { steps: 18 });
    x = nx; y = ny;
    await page.waitForTimeout(150);
  };

  await page.waitForTimeout(1200);
  const box = page.locator('textarea');
  await box.evaluate((t) => { t.spellcheck = false; });
  await goto(box);
  await page.mouse.click(x, y);
  await page.keyboard.type(question[lang], { delay: lang === 'en' ? 35 : 90 });
  await page.waitForTimeout(400);
  await goto(page.locator('.pf-chatbot__button--send'));
  await page.mouse.click(x, y);
  // off the button, so its tooltip does not cover the reply
  await page.mouse.move(1200, 480, { steps: 12 });
  x = 1200; y = 480;
  await page.waitForFunction(() => document.querySelectorAll('.msg-stats').length >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  // Copy the reply, then the history drawer: the conversation is kept.
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
  await page.waitForTimeout(500);
  const copy = page.locator('.pf-chatbot__response-actions .pf-chatbot__button--response-action').first();
  await goto(copy);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1300);
  await goto(page.locator('.pf-chatbot__canvas-history-toggle'));
  await page.mouse.click(x, y);
  await page.waitForTimeout(2500);

  await cdp.send('Page.stopScreencast');
  await ctx.close();
  if (errors.length) throw new Error(`${lang}: ${errors.join('; ')}`);
  return frames;
}

function encode(frames, gif) {
  const dir = mkdtempSync(join(tmpdir(), 'demo-gif-'));
  try {
    let list = '';
    frames.forEach((f, i) => {
      const name = `f${String(i).padStart(5, '0')}.png`;
      writeFileSync(join(dir, name), Buffer.from(f.data, 'base64'));
      // each frame stays until the next one; the last one for two seconds
      const d = i + 1 < frames.length ? Math.max(frames[i + 1].t - f.t, 0.001) : 2;
      list += `file '${name}'\nduration ${d.toFixed(3)}\n`;
    });
    list += `file 'f${String(frames.length - 1).padStart(5, '0')}.png'\n`;
    writeFileSync(join(dir, 'list.txt'), list);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
      '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop', '0', gif], { stdio: 'inherit' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failed = false;
for (const lang of ['en', 'zh-CN']) {
  try {
    const frames = await record(lang);
    const gif = join(out, `demo-${lang}.gif`);
    encode(frames, gif);
    const kb = Math.round(statSync(gif).size / 1024);
    console.log(`${gif} ${kb} KiB, ${frames.length} frames`);
    if (kb > 3 * 1024) { console.error(`${gif} is over 3 MiB`); failed = true; }
  } catch (e) {
    console.error(e.message);
    failed = true;
  }
}
await browser.close();
server.close();
if (failed) process.exitCode = 1;
