// SPDX-License-Identifier: GPL-2.0-only
//
// Models: what charsiu can fetch (`charsiu pull --zoo`), what is on disk, and
// one download at a time through `charsiu pull NAME`, which downloads,
// verifies and keeps the file only if it runs. Progress is the size of the
// .part file it writes, against the size the zoo lists.

use crate::parse::{is_model_file, parse_zoo};
use crate::proc::{self, Proc};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub name: String,
    pub repo: String,
    pub file: String,
    pub mmproj: String,
    pub mb: u64,
    pub total_mb: u64,
    pub note: String,
    pub installed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub file: String,
    pub path: String,
    pub bytes: u64,
    /// in the system directory (read only to the app)
    pub system: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Models {
    pub dir: String,
    pub sysdir: Option<String>,
    pub current: Option<String>,
    pub zoo: Vec<Row>,
    pub installed: Vec<Installed>,
}

fn run(charsiu: &str, args: &[&str]) -> Result<String, String> {
    let front = proc::charsiu_path(charsiu)?;
    let out = proc::command(&front, args)
        .output()
        .map_err(|e| format!("{}: {e}", front.display()))?;
    let so = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let se = String::from_utf8_lossy(&out.stderr);
        let msg = se.trim();
        return Err(if msg.is_empty() {
            so.trim().to_string()
        } else {
            msg.to_string()
        });
    }
    Ok(so)
}

fn scan(dir: &Path, system: bool, out: &mut Vec<Installed>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !is_model_file(&name) {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() || out.iter().any(|i| i.file == name) {
            continue;
        }
        out.push(Installed {
            file: name,
            path: e.path().to_string_lossy().to_string(),
            bytes: md.len(),
            system,
        });
    }
}

pub fn list(charsiu: &str) -> Result<Models, String> {
    let z = parse_zoo(&run(charsiu, &["pull", "--zoo"])?);
    if z.dir.is_empty() {
        return Err("`charsiu pull --zoo` did not name a model directory; this charsiu is too old for the app".into());
    }
    let mut installed = Vec::new();
    scan(Path::new(&z.dir), false, &mut installed);
    if let Some(s) = &z.sysdir {
        scan(Path::new(s), true, &mut installed);
    }
    // the model the config names may live anywhere (R:\npu\model.gguf on the
    // board): list it too, so the picker can show what charsiu will run
    if let Some(cur) = &z.current {
        let p = Path::new(cur);
        if let Ok(md) = std::fs::metadata(p) {
            if md.is_file() && !installed.iter().any(|i| Path::new(&i.path) == p) {
                installed.push(Installed {
                    file: p
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| cur.clone()),
                    path: cur.clone(),
                    bytes: md.len(),
                    system: true,
                });
            }
        }
    }
    installed.sort_by(|a, b| a.file.to_lowercase().cmp(&b.file.to_lowercase()));
    let zoo = z
        .rows
        .iter()
        .filter(|r| r.is_chat())
        .map(|r| Row {
            name: r.name.clone(),
            repo: r.repo.clone(),
            file: r.file.clone(),
            mmproj: r.mmproj.clone(),
            mb: r.mb,
            total_mb: r.total_mb(),
            note: r.note.clone(),
            installed: installed.iter().any(|i| i.file == r.file),
        })
        .collect();
    Ok(Models {
        dir: z.dir,
        sysdir: z.sysdir,
        current: z.current,
        zoo,
        installed,
    })
}

pub fn remove(charsiu: &str, file: &str) -> Result<(), String> {
    run(charsiu, &["rm", "-f", file]).map(|_| ())
}

// ---- one download ------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub name: String,
    pub file: String,
    #[serde(default)]
    pub mmproj: String,
    pub total_mb: u64,
    pub dir: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PullStatus {
    pub name: String,
    /// "idle", "running", "done", "failed", "cancelled"
    pub state: String,
    pub bytes: u64,
    pub total: u64,
    pub message: Option<String>,
}

struct PullInner {
    proc: Option<Proc>,
    req: Option<PullRequest>,
    status: PullStatus,
    log: VecDeque<String>,
}

#[derive(Clone)]
pub struct Pull(Arc<Mutex<PullInner>>);

impl Default for Pull {
    fn default() -> Self {
        Pull(Arc::new(Mutex::new(PullInner {
            proc: None,
            req: None,
            status: PullStatus {
                state: "idle".into(),
                ..Default::default()
            },
            log: VecDeque::new(),
        })))
    }
}

fn size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Bytes on disk for one file: the finished file, else its .part.
fn have(dir: &Path, file: &str) -> u64 {
    if file.is_empty() {
        return 0;
    }
    let f = dir.join(file);
    let s = size(&f);
    if s > 0 {
        return s;
    }
    let mut part = f.into_os_string();
    part.push(".part");
    size(&PathBuf::from(part))
}

impl Pull {
    pub fn start(&self, charsiu: &str, req: PullRequest) -> Result<(), String> {
        let mut g = self.0.lock().unwrap();
        if g.status.state == "running" {
            return Err(format!("{} is still downloading", g.status.name));
        }
        let front = proc::charsiu_path(charsiu)?;
        let mut p = Proc::spawn(proc::command(&front, &["pull", &req.name]))
            .map_err(|e| format!("{}: {e}", front.display()))?;
        g.log.clear();
        for r in [
            p.child
                .stderr
                .take()
                .map(|r| Box::new(r) as Box<dyn Read + Send>),
            p.child
                .stdout
                .take()
                .map(|r| Box::new(r) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let me = self.clone();
            std::thread::spawn(move || me.read(r));
        }
        g.status = PullStatus {
            name: req.name.clone(),
            state: "running".into(),
            bytes: 0,
            total: req.total_mb * 1_048_576,
            message: None,
        };
        g.proc = Some(p);
        g.req = Some(req);
        Ok(())
    }

    fn read(&self, mut r: Box<dyn Read + Send>) {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        while let Ok(n) = r.read(&mut tmp) {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            while let Some(i) = buf.iter().position(|&b| b == b'\n' || b == b'\r') {
                let l: Vec<u8> = buf.drain(..=i).collect();
                let l = String::from_utf8_lossy(&l[..l.len() - 1])
                    .trim()
                    .to_string();
                if !l.is_empty() {
                    let mut g = self.0.lock().unwrap();
                    if g.log.len() >= 40 {
                        g.log.pop_front();
                    }
                    g.log.push_back(l);
                }
            }
        }
    }

    pub fn status(&self) -> PullStatus {
        let mut guard = self.0.lock().unwrap();
        let g = &mut *guard;
        if let Some(r) = &g.req {
            let d = Path::new(&r.dir);
            g.status.bytes = have(d, &r.file) + have(d, &r.mmproj);
        }
        let exited = match g.proc.as_mut() {
            Some(p) => p.child.try_wait().ok().flatten(),
            None => None,
        };
        if let Some(st) = exited {
            g.proc.take();
            if g.status.state == "running" {
                if st.success() {
                    g.status.state = "done".into();
                } else {
                    g.status.state = "failed".into();
                    // the last thing charsiu said is the reason
                    let why = g
                        .log
                        .iter()
                        .rev()
                        .find(|l| {
                            l.contains("ERROR") || l.contains("error") || l.contains("cannot")
                        })
                        .or(g.log.back())
                        .cloned()
                        .unwrap_or_else(|| format!("charsiu pull exited with {st}"));
                    g.status.message = Some(why);
                }
            }
        }
        g.status.clone()
    }

    pub fn cancel(&self) {
        let p = {
            let mut g = self.0.lock().unwrap();
            if g.status.state == "running" {
                g.status.state = "cancelled".into();
            }
            g.proc.take()
        };
        drop(p);
    }
}
