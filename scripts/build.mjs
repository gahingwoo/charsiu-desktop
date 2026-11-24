// Build the page into dist/, which Tauri embeds (tauri.conf.json frontendDist).
// esbuild, as Maskrom Studio's scripts/build.mjs does it: one ES module and
// one stylesheet, fonts and pictures beside them. Prints the sizes, since the
// page runs in WebView2 on a board with 4 GB.
// SPDX-License-Identifier: GPL-2.0-only
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const commit = (process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD')).slice(0, 7) || 'unknown';
const built = new Date().toISOString().slice(0, 10);
const version = (p) => JSON.parse(readFileSync(`node_modules/${p}/package.json`, 'utf8')).version;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: { app: 'src/main.tsx' },
  outdir: 'dist',
  bundle: true,
  platform: 'browser',
  target: ['chrome120', 'safari16'],
  format: 'esm',
  minify: true,
  legalComments: 'linked',
  jsx: 'automatic',
  logLevel: 'warning',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.otf': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file', '.gif': 'file' },
  assetNames: 'assets/[name]-[hash]',
  define: {
    'process.env.NODE_ENV': '"production"',
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_DATE__: JSON.stringify(built),
    __PATTERNFLY_VERSION__: JSON.stringify(version('@patternfly/react-core')),
    __CHATBOT_VERSION__: JSON.stringify(version('@patternfly/chatbot')),
  },
});
cpSync('src/index.html', 'dist/index.html');
cpSync('src/theme.js', 'dist/theme.js');

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
let total = 0;
for (const f of walk('dist').sort()) {
  const n = statSync(f).size;
  total += n;
  if (n > 20000) console.log(`${(n / 1024).toFixed(0).padStart(7)} KiB  ${f}`);
}
console.log(`${(total / 1024).toFixed(0).padStart(7)} KiB  dist/ in all (${commit}, PatternFly ${version('@patternfly/react-core')}, Chatbot ${version('@patternfly/chatbot')})`);
