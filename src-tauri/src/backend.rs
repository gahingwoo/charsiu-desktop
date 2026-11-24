// SPDX-License-Identifier: GPL-2.0-only
//
// `charsiu serve`, started and watched. The app is only a front end: the
// model, the NPU and the HTTP server are charsiu's, on 127.0.0.1 and a port
// the server picks itself (--port 0) and announces on stderr.

use crate::parse::{classify, Line};
use crate::proc::{self, Proc};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const LOG_LINES: usize = 200;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// "stopped", "starting", "loading", "ready", "failed"
    pub state: String,
    pub port: Option<u16>,
    /// the model asked for (a path), if the app chose one
    pub model: Option<String>,
    /// what the server says it serves (GET /health)
    pub served: Option<String>,
    pub context: Option<u64>,
    pub staged: Option<u32>,
    pub total: Option<u32>,
    /// "unknown", "on", "off"
    pub npu: String,
    pub devices: Option<u32>,
    /// why the NPU is not used: "admin", "driver"
    pub npu_problem: Option<String>,
    /// why the backend failed: "not_installed", "no_model", "model_missing",
    /// "not_built", "exited", "spawn"
    pub problem: Option<String>,
    pub detail: Option<String>,
}

struct Inner {
    proc: Option<Proc>,
    snap: Snapshot,
    log: VecDeque<String>,
    generation: u64,
}

#[derive(Clone)]
pub struct Backend(Arc<Mutex<Inner>>);

impl Default for Backend {
    fn default() -> Self {
        Backend(Arc::new(Mutex::new(Inner {
            proc: None,
            snap: Snapshot {
                state: "stopped".into(),
                npu: "unknown".into(),
                ..Default::default()
            },
            log: VecDeque::new(),
            generation: 0,
        })))
    }
}

impl Backend {
    pub fn snapshot(&self) -> Snapshot {
        self.0.lock().unwrap().snap.clone()
    }

    pub fn log(&self) -> Vec<String> {
        self.0.lock().unwrap().log.iter().cloned().collect()
    }

    pub fn port(&self) -> Option<u16> {
        let g = self.0.lock().unwrap();
        (g.snap.state == "ready").then_some(g.snap.port).flatten()
    }

    fn emit(app: &AppHandle, s: &Snapshot) {
        let _ = app.emit("backend", s.clone());
    }

    pub fn stop(&self, app: &AppHandle) {
        let p = {
            let mut g = self.0.lock().unwrap();
            g.generation += 1;
            g.snap = Snapshot {
                state: "stopped".into(),
                npu: "unknown".into(),
                ..Default::default()
            };
            Self::emit(app, &g.snap);
            g.proc.take()
        };
        // killing waits for the child; not under the lock
        drop(p);
    }

    pub fn start(&self, app: &AppHandle, charsiu: &str, model: Option<String>) {
        self.stop(app);
        let mut g = self.0.lock().unwrap();
        g.log.clear();
        let gen = g.generation;
        g.snap.model = model.clone();
        let front = match proc::charsiu_path(charsiu) {
            Ok(p) => p,
            Err(e) => {
                g.snap.state = "failed".into();
                g.snap.problem = Some("not_installed".into());
                g.snap.detail = Some(e);
                Self::emit(app, &g.snap);
                return;
            }
        };
        let mut c = proc::command(&front, &["serve", "--host", "127.0.0.1", "--port", "0"]);
        if let Some(m) = &model {
            c.env("CHARSIU_MODEL", m);
        }
        push_log(
            &mut g.log,
            format!("$ {} serve --host 127.0.0.1 --port 0", front.display()),
        );
        let mut p = match Proc::spawn(c) {
            Ok(p) => p,
            Err(e) => {
                g.snap.state = "failed".into();
                g.snap.problem = Some("spawn".into());
                g.snap.detail = Some(format!("{}: {e}", front.display()));
                Self::emit(app, &g.snap);
                return;
            }
        };
        let err = p.child.stderr.take();
        let out = p.child.stdout.take();
        g.proc = Some(p);
        g.snap.state = "starting".into();
        Self::emit(app, &g.snap);
        drop(g);

        if let Some(o) = out {
            let me = self.clone();
            let app = app.clone();
            std::thread::spawn(move || me.read(o, gen, &app, false));
        }
        if let Some(e) = err {
            let me = self.clone();
            let app = app.clone();
            std::thread::spawn(move || me.read(e, gen, &app, true));
        }
    }

    /// Read one of the child's outputs line by line. The stderr reader also
    /// notices the end: EOF there means the server is gone.
    fn read(&self, mut r: impl Read, gen: u64, app: &AppHandle, is_err: bool) {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        loop {
            let n = match r.read(&mut tmp) {
                Ok(0) | Err(_) => 0,
                Ok(n) => n,
            };
            if n == 0 {
                if !buf.is_empty() {
                    let l = String::from_utf8_lossy(&buf).to_string();
                    self.line(&l, gen, app);
                }
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            while let Some(i) = buf.iter().position(|&b| b == b'\n' || b == b'\r') {
                let l: Vec<u8> = buf.drain(..=i).collect();
                let l = String::from_utf8_lossy(&l[..l.len() - 1]).to_string();
                if !l.trim().is_empty() {
                    self.line(&l, gen, app);
                }
            }
        }
        if is_err {
            self.ended(gen, app);
        }
    }

    fn line(&self, l: &str, gen: u64, app: &AppHandle) {
        let mut g = self.0.lock().unwrap();
        if g.generation != gen {
            return;
        }
        push_log(&mut g.log, l.to_string());
        let Some(ev) = classify(l) else { return };
        let s = &mut g.snap;
        match ev {
            Line::Ready { port, .. } => {
                s.state = "ready".into();
                s.port = Some(port);
                if s.npu == "unknown" {
                    // a server that staged nothing and said nothing ran on the CPU
                    s.npu = if s.total.is_some() || s.devices.is_some() {
                        "on"
                    } else {
                        "off"
                    }
                    .into();
                }
                let me = self.clone();
                let app = app.clone();
                std::thread::spawn(move || me.health(port, gen, &app));
            }
            Line::Staging { total } => {
                s.state = "loading".into();
                s.total = Some(total);
                s.staged = Some(0);
            }
            Line::Staged { done } => {
                s.state = "loading".into();
                s.staged = Some(done);
            }
            Line::NpuOn { devices } => {
                s.npu = "on".into();
                s.devices = Some(devices);
            }
            Line::NpuOff => s.npu = "off".into(),
            Line::AdminNeeded => s.npu_problem = Some("admin".into()),
            Line::DriverMissing => s.npu_problem = Some("driver".into()),
            Line::NoModel => s.problem = Some("no_model".into()),
            Line::ModelMissing => s.problem = Some("model_missing".into()),
            Line::NotBuilt => s.problem = Some("not_built".into()),
        }
        Self::emit(app, &g.snap);
    }

    fn health(&self, port: u16, gen: u64, app: &AppHandle) {
        let Ok(v) = crate::http::get_json(port, "/health") else {
            return;
        };
        let mut g = self.0.lock().unwrap();
        if g.generation != gen {
            return;
        }
        g.snap.served = v["model"].as_str().map(str::to_string);
        g.snap.context = v["context"].as_u64();
        Self::emit(app, &g.snap);
    }

    fn ended(&self, gen: u64, app: &AppHandle) {
        // give the process a moment to be reapable, for its exit code
        let mut code = None;
        for _ in 0..40 {
            {
                let mut g = self.0.lock().unwrap();
                if g.generation != gen {
                    return;
                }
                if let Some(p) = g.proc.as_mut() {
                    if let Ok(Some(st)) = p.child.try_wait() {
                        code = Some(st.code());
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let mut g = self.0.lock().unwrap();
        if g.generation != gen {
            return;
        }
        g.proc.take();
        let tail: Vec<String> = g.log.iter().rev().take(6).rev().cloned().collect();
        let s = &mut g.snap;
        s.state = "failed".into();
        s.port = None;
        if s.problem.is_none() {
            s.problem = Some("exited".into());
        }
        let how = match code.flatten() {
            Some(c) => format!("charsiu serve exited with code {c}"),
            None => "charsiu serve stopped".to_string(),
        };
        s.detail = Some(format!("{how}\n{}", tail.join("\n")));
        Self::emit(app, &g.snap);
    }
}

fn push_log(log: &mut VecDeque<String>, l: String) {
    if log.len() >= LOG_LINES {
        log.pop_front();
    }
    log.push_back(l);
}
