// A stand-in for the Tauri API, for screenshots and for looking at the page
// in a browser without the app: window.__TAURI__ with the commands
// src-tauri/src/lib.rs has, answering with what a TaishanPi 3M under Windows
// would. Never part of the app; scripts/shots.mjs injects it.
//
//   ?scene=chat|welcome|failed  &lang=en|zh-CN
// SPDX-License-Identifier: GPL-2.0-only
(function () {
  const q = new URLSearchParams(location.search);
  const scene = q.get('scene') || 'chat';
  const lang = q.get('lang') || 'en';
  const zh = lang === 'zh-CN';
  const listeners = {};
  const now = Date.now();
  const dir = 'C:\\Users\\board\\AppData\\Local\\charsiu\\models';
  const configured = 'R:\\npu\\Llama-3.2-1B-Instruct-Q8_0.gguf';

  const answer = zh
    ? 'NPU（神经网络处理器）是专门做矩阵乘法的芯片单元。RK3576 的 NPU 有两个核心，charsiu 把模型的线性层放到上面跑，CPU 只做剩下的部分。\n\n用 Python 反转字符串：\n\n```python\ndef reverse(s: str) -> str:\n    return s[::-1]\n\nprint(reverse("charsiu"))  # uisrahc\n```\n\n切片 `[::-1]` 从尾到头取每个字符。'
    : 'An NPU is a block of the chip built for the matrix multiplications a neural network is made of. The RK3576 has two NPU cores, and charsiu runs the model\'s linear layers on them while the CPU does the rest.\n\nReversing a string in Python:\n\n```python\ndef reverse(s: str) -> str:\n    return s[::-1]\n\nprint(reverse("charsiu"))  # uisrahc\n```\n\nThe slice `[::-1]` walks the string from the end to the start.';
  const question = zh ? '什么是 NPU？再写一个反转字符串的 Python 函数。' : 'What is an NPU? And write a Python function that reverses a string.';

  const conv = (id, title, ago, messages) => ({ id, title, created: now - ago, updated: now - ago, messages });
  const conversations = scene === 'chat' ? [
    conv('c1', zh ? '什么是 NPU' : 'What is an NPU', 60e3, [
      { id: 'm1', role: 'user', content: question, at: now - 70e3 },
      { id: 'm2', role: 'assistant', content: answer, at: now - 60e3, stats: { tokens: 118, ttft: 820, tps: 14.6, finish: 'stop' } },
    ]),
    conv('c2', zh ? '翻译一段话' : 'Translate a paragraph', 3600e3, []),
    conv('c3', zh ? '周末计划' : 'Weekend plans', 86400e3 * 2, []),
    conv('c4', zh ? 'RK3576 的内存带宽' : 'Memory bandwidth on the RK3576', 86400e3 * 5, []),
  ] : [];

  const ready = {
    state: 'ready', port: 51234, model: null, served: 'Llama-3.2-1B-Instruct-Q8_0.gguf', context: 2048,
    staged: null, total: null, npu: 'on', devices: 2, npuProblem: null, problem: null, detail: null,
  };
  const failed = { state: 'failed', npu: 'unknown', problem: 'no_model', detail: 'charsiu serve: no model set and none here. Try: charsiu pull' };
  let snap = scene === 'failed' ? failed : ready;
  let chats = 0;

  const zoo = [
    ['smollm2-135m-q4', 92, 'smallest thing that talks; good for a first run'],
    ['qwen3-0.6b-q4', 409, '0.6B that reasons in <think>; smallest of the new ones'],
    ['llama3.2-1b-q4', 773, ''],
    ['llama3.2-1b-q8', 1321, 'THE ONE EVERY BOARD ROUND USES'],
    ['qwen2.5-1.5b-q4', 894, 'answers better than the 1B llamas'],
    ['gemma3-1b-q4', 689, '32K context on a 512 sliding window'],
  ].map(([name, mb, note]) => ({ name, repo: 'bartowski/x', file: `${name}.gguf`, mmproj: '', mb, totalMb: mb, note, installed: name === 'qwen3-0.6b-q4' }));

  const commands = {
    load_data: () => ({ settings: { language: lang === 'en' && !q.get('lang') ? '' : lang }, conversations: { version: 1, current: conversations[0] ? 'c1' : null, conversations } }),
    app_info: () => ({ os: 'windows', version: '0.1.0', charsiu: 'C:\\Users\\board\\AppData\\Local\\Programs\\charsiu\\charsiu.ps1', home: 'C:\\Users\\board', user: 'board' }),
    backend_state: () => snap,
    backend_start: () => { setTimeout(() => (listeners.backend || []).forEach((f) => f({ payload: snap })), 50); return null; },
    backend_stop: () => null,
    backend_log: () => [
      'charsiu_serve: loading R:\\npu\\Llama-3.2-1B-Instruct-Q8_0.gguf',
      'charsiu: Llama-3.2-1B-Instruct-Q8_0.gguf (llama, 16 layers)',
      'charsiu rknpu: M7 driver; cache maintenance fused into SUBMIT and WAIT',
      'charsiu NPU: weights are int4, 2 devices',
      'charsiu: weight cache R:\\npu\\Llama-3.2-1B-Instruct-Q8_0.gguf.wcache, reading',
      'charsiu_serve: ready on http://127.0.0.1:51234  (model Llama-3.2-1B-Instruct-Q8_0.gguf, ctx 2048)',
    ],
    models_list: () => ({
      dir, sysdir: null, current: configured, zoo,
      installed: [
        { file: 'Llama-3.2-1B-Instruct-Q8_0.gguf', path: configured, bytes: 1321e6, system: true },
        { file: 'qwen3-0.6b-q4.gguf', path: `${dir}\\qwen3-0.6b-q4.gguf`, bytes: 409e6, system: false },
      ],
    }),
    model_remove: () => null,
    pull_start: () => null,
    pull_status: () => ({ name: '', state: 'idle', bytes: 0, total: 0 }),
    pull_cancel: () => null,
    npu_status: () => ({
      platform: 'windows', device: 'started', problem: null, driverLoaded: true, counters: 'ok', bufferBytes: 7.1e8, rail: null,
      cores: [{ name: 'core0', busy: 0, jobsPerSec: 0 }, { name: 'core1', busy: 0, jobsPerSec: 0 }],
    }),
    save_settings: () => null,
    save_conversations: () => null,
    open_url: () => null,
    chat_cancel: () => null,
    chat: async (args) => {
      const ch = args.onEvent;
      chats += 1;
      // what the 0.1.0 board run saw: a staging heartbeat after "ready"
      // (the last one, 112 of 113). The page must keep Send.
      if (chats === 1) {
        snap = { ...snap, state: 'loading', staged: 112, total: 113 };
        (listeners.backend || []).forEach((f) => f({ payload: snap }));
      }
      ch.onmessage({ kind: 'sent' });
      for (const w of answer.split(/(?<=\s)/)) {
        await new Promise((r) => setTimeout(r, q.get('fast') ? 2 : 30));
        ch.onmessage({ kind: 'token', text: w });
      }
      ch.onmessage({ kind: 'done', finish: 'stop' });
      return null;
    },
  };

  class Channel { constructor() { this.onmessage = () => {}; } }
  window.__TAURI__ = {
    core: {
      Channel,
      invoke: (cmd, args) => {
        const f = commands[cmd];
        if (!f) return Promise.reject(new Error(`mock: no command ${cmd}`));
        try { return Promise.resolve(f(args || {})); } catch (e) { return Promise.reject(e); }
      },
    },
    event: {
      listen: (name, cb) => { (listeners[name] = listeners[name] || []).push(cb); return Promise.resolve(() => {}); },
    },
  };
})();
