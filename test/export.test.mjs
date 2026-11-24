// The Markdown export (src/export.ts) and the strings it uses. Plain
// node:test, no dependencies: Node 22.18 and later strip the types from
// src/*.ts on import.
//
//   npm test
// SPDX-License-Identifier: GPL-2.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeFences, fileName, stamp, toMarkdown } from '../src/export.ts';
import { MESSAGES } from '../src/messages.ts';

const en = { untitled: 'New conversation', you: 'You', assistant: 'Assistant', colon: ':' };
const at = new Date(2026, 10, 25, 9, 5).getTime();
const conv = (messages, title = 'What is an NPU') => ({ id: 'c1', title, created: at, updated: at, messages });

test('title, date, then each turn', () => {
  const md = toMarkdown(conv([
    { id: 'a', role: 'user', content: 'Reverse a string?' },
    { id: 'b', role: 'assistant', content: 'Like this:\n\n```python\nprint("charsiu"[::-1])\n```\n\nDone.\n' },
  ]), en);
  assert.equal(md, [
    '# What is an NPU',
    '',
    '2026-11-25 09:05',
    '',
    '**You:**',
    '',
    'Reverse a string?',
    '',
    '**Assistant:**',
    '',
    'Like this:',
    '',
    '```python',
    'print("charsiu"[::-1])',
    '```',
    '',
    'Done.',
    '',
  ].join('\n'));
});

test('code is kept byte for byte, indentation and blank lines too', () => {
  const code = '```rust\nfn main() {\n\n    println!("**not bold**");\n}\n```';
  assert.ok(toMarkdown(conv([{ id: 'b', role: 'assistant', content: code }]), en).includes(`\n${code}\n`));
});

test('empty and failed turns are left out, an untitled conversation gets a title', () => {
  const md = toMarkdown(conv([
    { id: 'a', role: 'user', content: 'Hi' },
    { id: 'b', role: 'assistant', content: '', error: 'charsiu serve stopped' },
  ], ''), en);
  assert.ok(md.startsWith('# New conversation\n'));
  assert.equal(md.match(/\*\*Assistant:\*\*/g), null);
});

test('a reply stopped inside a code block does not swallow the next turn', () => {
  assert.equal(closeFences('```js\nlet a = 1;\n'), '```js\nlet a = 1;\n```');
  assert.equal(closeFences('````\n```\nstill code'), '````\n```\nstill code\n````');
  assert.equal(closeFences('~~~\nx\n~~~'), '~~~\nx\n~~~');
  assert.equal(closeFences('no code here'), 'no code here');
  const md = toMarkdown(conv([
    { id: 'a', role: 'assistant', content: '```py\nwhile True:' },
    { id: 'b', role: 'user', content: 'Stop' },
  ]), en);
  assert.ok(md.includes('while True:\n```\n\n**You:**'));
});

test('Chinese labels', () => {
  const zh = { untitled: '新对话', you: '你', assistant: '助手', colon: '：' };
  const md = toMarkdown(conv([{ id: 'a', role: 'user', content: '你好' }], '叉烧'), zh);
  assert.ok(md.startsWith('# 叉烧\n\n'));
  assert.ok(md.includes('**你：**\n\n你好\n'));
});

test('file names', () => {
  assert.equal(fileName('What is an NPU', 'conversation'), 'What is an NPU.md');
  assert.equal(fileName('a/b\\c: "d" <e>?*|', 'conversation'), 'a b c d e.md');
  assert.equal(fileName('  ...  ', 'conversation'), 'conversation.md');
  assert.equal(fileName('line\none', 'x'), 'line one.md');
  assert.equal(fileName('x'.repeat(200), 'c').length, 83);
  assert.equal(fileName('翻译一段话', 'c'), '翻译一段话.md');
});

test('stamp is local time, zero padded', () => {
  assert.equal(stamp(new Date(2026, 0, 2, 3, 4).getTime()), '2026-01-02 03:04');
});

test('every string has English and Chinese', () => {
  for (const [k, v] of Object.entries(MESSAGES)) {
    assert.ok(v.en, `${k}: no English`);
    assert.ok(v['zh-CN'], `${k}: no Chinese`);
  }
});
