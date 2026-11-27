// SPDX-License-Identifier: GPL-2.0-only
//
// What the app reads out of charsiu's text: the backend's stderr, the model
// list from `charsiu pull --zoo`, and the server-sent event framing of a
// streamed reply. std only, so it can be tested on its own.

/// One line of the backend's stderr, read for what the app needs to know.
#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    /// `charsiu_serve: ready on http://HOST:PORT  (model NAME, ctx N)`
    Ready { host: String, port: u16 },
    /// `... staging N`: N NPU tensors will be staged
    Staging { total: u32 },
    /// `... N tensors staged`
    Staged { done: u32 },
    /// `charsiu NPU: weights are ..., N devices`
    NpuOn { devices: u32 },
    /// `charsiu: no NPU; staying on the CPU`
    NpuOff,
    /// the NPU device refused this user (Windows error 5)
    AdminNeeded,
    /// the NPU device is not there (Windows error 2, or the Linux node)
    DriverMissing,
    /// the front door found no model to serve
    NoModel,
    /// the model the front door was given is not on disk
    ModelMissing,
    /// the front door could not find charsiu_serve
    NotBuilt,
}

/// Classify one stderr line. Lines that matter to nobody return None.
pub fn classify(line: &str) -> Option<Line> {
    let l = line.trim();
    if let Some((host, port)) = parse_ready(l) {
        return Some(Line::Ready { host, port });
    }
    if l.contains("cannot open") && l.contains("RKNPU") {
        if l.contains("error 5)") || l.contains("administrator") {
            return Some(Line::AdminNeeded);
        }
        return Some(Line::DriverMissing);
    }
    // the front door's own warning, before charsiu_serve tries
    if l.contains("lets only administrators use the NPU") {
        return Some(Line::AdminNeeded);
    }
    if l.contains("no NPU; staying on the CPU") {
        return Some(Line::NpuOff);
    }
    if l.starts_with("charsiu NPU: weights are") {
        if let Some(n) = number_before(l, " devices") {
            return Some(Line::NpuOn { devices: n });
        }
    }
    if l.contains("tensors staged") {
        if let Some(n) = number_before(l, " tensors staged") {
            return Some(Line::Staged { done: n });
        }
    }
    if let Some(rest) = last_word_after(l, "staging ") {
        if let Ok(n) = rest.parse::<u32>() {
            return Some(Line::Staging { total: n });
        }
    }
    if l.contains("no model set") {
        return Some(Line::NoModel);
    }
    if l.contains("does not exist") && l.contains("charsiu pull") {
        return Some(Line::ModelMissing);
    }
    if l.contains("charsiu_serve is not built")
        || (l.contains("cannot find") && l.contains("charsiu_serve"))
    {
        return Some(Line::NotBuilt);
    }
    None
}

/// `ready on http://([0-9.]+):(\d+)`
pub fn parse_ready(l: &str) -> Option<(String, u16)> {
    let i = l.find("ready on http://")?;
    let rest = &l[i + "ready on http://".len()..];
    let colon = rest.find(':')?;
    let host = &rest[..colon];
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let digits: String = rest[colon + 1..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let port: u16 = digits.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some((host.to_string(), port))
}

/// The integer immediately before `marker`, e.g. "2" in "x, 2 devices".
fn number_before(l: &str, marker: &str) -> Option<u32> {
    let i = l.find(marker)?;
    let head = l[..i].trim_end();
    let digits: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().ok()
}

/// The text after the last `marker`, if that is the end of the line.
fn last_word_after<'a>(l: &'a str, marker: &str) -> Option<&'a str> {
    let i = l.rfind(marker)?;
    let rest = &l[i + marker.len()..];
    if rest.is_empty() || rest.contains(' ') {
        return None;
    }
    Some(rest)
}

/// A row of charsiu's model zoo.
#[derive(Debug, Clone, PartialEq)]
pub struct ZooRow {
    pub name: String,
    pub repo: String,
    pub file: String,
    pub mb: u64,
    pub note: String,
    pub mmproj: String,
    pub mmproj_mb: u64,
}

impl ZooRow {
    /// Chat models only: whisper and CLIP files are not conversations.
    pub fn is_chat(&self) -> bool {
        self.file.ends_with(".gguf")
            && !self.name.starts_with("clip-")
            && !self.name.starts_with("whisper-")
    }
    /// The whole download: a model that sees is two files.
    pub fn total_mb(&self) -> u64 {
        self.mb + self.mmproj_mb
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Zoo {
    pub dir: String,
    pub sysdir: Option<String>,
    pub current: Option<String>,
    pub rows: Vec<ZooRow>,
}

/// Parse `charsiu pull --zoo`. Unknown line kinds are skipped, so the
/// format can grow.
pub fn parse_zoo(text: &str) -> Zoo {
    let mut z = Zoo::default();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        let mut f = line.split('|');
        match f.next() {
            Some("dir") => z.dir = rest_of(line, 1),
            Some("sysdir") => {
                let d = rest_of(line, 1);
                if !d.is_empty() {
                    z.sysdir = Some(d)
                }
            }
            Some("current") => {
                let d = rest_of(line, 1);
                if !d.is_empty() {
                    z.current = Some(d)
                }
            }
            Some("zoo") => {
                let v: Vec<&str> = f.collect();
                if v.len() < 4 || v[0].is_empty() || v[2].is_empty() {
                    continue;
                }
                let num = |i: usize| {
                    v.get(i)
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .unwrap_or(0)
                };
                let s = |i: usize| v.get(i).map(|s| s.to_string()).unwrap_or_default();
                z.rows.push(ZooRow {
                    name: s(0),
                    repo: s(1),
                    file: s(2),
                    mb: num(3),
                    note: s(4),
                    mmproj: s(5),
                    mmproj_mb: num(6),
                });
            }
            _ => {}
        }
    }
    z
}

/// Everything after the first `n` fields (a path may hold a `|`, in theory).
fn rest_of(line: &str, n: usize) -> String {
    line.splitn(n + 1, '|').nth(n).unwrap_or("").to_string()
}

/// Is this file a chat model the app should list as installed?
pub fn is_model_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".gguf") && !lower.starts_with("mmproj-")
}

/// Server-sent events, framed by lines. Feed it bytes as they arrive; it
/// hands back each `data:` payload once its line is complete.
#[derive(Default)]
pub struct Sse {
    buf: Vec<u8>,
}

impl Sse {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            let s = String::from_utf8_lossy(&line);
            let s = s.trim_end_matches(['\n', '\r']);
            if let Some(d) = s.strip_prefix("data:") {
                out.push(d.trim_start().to_string());
            }
        }
        out
    }
}

/// Undo HTTP/1.1 chunked transfer coding, incrementally.
#[derive(Default)]
pub struct Dechunk {
    buf: Vec<u8>,
    left: usize,
    pub done: bool,
}

impl Dechunk {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            if self.done {
                self.buf.clear();
                return out;
            }
            if self.left == usize::MAX {
                if self.buf.len() < 2 {
                    return out;
                }
                self.buf.drain(..2);
                self.left = 0;
                continue;
            }
            if self.left > 0 {
                let n = self.left.min(self.buf.len());
                if n == 0 {
                    return out;
                }
                out.extend(self.buf.drain(..n));
                self.left -= n;
                if self.left == 0 {
                    // the CRLF after the chunk; wait for it to arrive
                    self.left = usize::MAX;
                }
                continue;
            }
            let Some(i) = self.buf.iter().position(|&b| b == b'\n') else {
                return out;
            };
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            let s = String::from_utf8_lossy(&line);
            let hex = s.trim().split(';').next().unwrap_or("");
            match usize::from_str_radix(hex, 16) {
                Ok(0) => self.done = true,
                Ok(n) => self.left = n,
                Err(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line() {
        let l = "charsiu_serve: ready on http://127.0.0.1:54321  (model Llama.gguf, ctx 2048)";
        assert_eq!(
            classify(l),
            Some(Line::Ready {
                host: "127.0.0.1".into(),
                port: 54321
            })
        );
        assert_eq!(parse_ready("ready on http://0.0.0.0:0  (x)"), None);
        assert_eq!(parse_ready("ready on http://host:80"), None);
    }

    #[test]
    fn npu_lines() {
        assert_eq!(
            classify("charsiu NPU: weights are int4 w4a16, 2 devices"),
            Some(Line::NpuOn { devices: 2 })
        );
        assert_eq!(
            classify("charsiu: no NPU; staying on the CPU"),
            Some(Line::NpuOff)
        );
        assert_eq!(
            classify("charsiu: cannot open \\\\.\\RKNPU (Windows error 5): run as administrator"),
            Some(Line::AdminNeeded)
        );
        assert_eq!(
            classify("[charsiu] WARN: rknpu.sys lets only administrators use the NPU here. Run charsiu-install.ps1 once from an administrator PowerShell (it lets ordinary users use the NPU, then restart), or run this from an administrator terminal. This run uses the CPU."),
            Some(Line::AdminNeeded)
        );
        assert_eq!(
            classify("charsiu: cannot open \\\\.\\RKNPU (Windows error 2): is rknpu.sys installed and the NPU enabled in the firmware setup?"),
            Some(Line::DriverMissing)
        );
    }

    #[test]
    fn staging_lines() {
        assert_eq!(
            classify("charsiu NPU: staging 113"),
            Some(Line::Staging { total: 113 })
        );
        assert_eq!(
            classify("charsiu NPU: 48 tensors staged"),
            Some(Line::Staged { done: 48 })
        );
        assert_eq!(
            classify("charsiu: 113 of 113 tensors ON THE HARDWARE"),
            None
        );
    }

    #[test]
    fn front_door_errors() {
        assert_eq!(
            classify("charsiu serve: no model set. Try: charsiu setup"),
            Some(Line::NoModel)
        );
        assert_eq!(
            classify("charsiu serve: C:\\m\\x.gguf does not exist (charsiu pull)"),
            Some(Line::ModelMissing)
        );
        assert_eq!(
            classify("charsiu serve: charsiu_serve is not built"),
            Some(Line::NotBuilt)
        );
        assert_eq!(
            classify("charsiu: cannot find 'charsiu_serve'."),
            Some(Line::NotBuilt)
        );
        assert_eq!(classify("  POST /v1/chat/completions  120 bytes"), None);
    }

    #[test]
    fn zoo() {
        let t = "dir|C:\\Users\\a\\AppData\\Local\\charsiu\\models\r\n\
                 sysdir|/opt/charsiu/models\n\
                 current|/x/y.gguf\n\
                 zoo|smollm2-135m-q4|bartowski/SmolLM2-135M-Instruct-GGUF|SmolLM2-135M-Instruct-Q4_0.gguf|92|smallest thing that talks||\n\
                 zoo|smolvlm-256m|ggml-org/SmolVLM-256M-Instruct-GGUF|SmolVLM-256M-Instruct-Q8_0.gguf|175|SEES|mmproj-SmolVLM-256M-Instruct-Q8_0.gguf|104\n\
                 zoo|clip-b32|mys/x|clip.gguf|90|MATCHES||\n\
                 zoo|whisper-tiny.en|ggerganov/whisper.cpp|ggml-tiny.en.bin|78|HEARS||\n\
                 something|else\n";
        let z = parse_zoo(t);
        assert_eq!(z.dir, "C:\\Users\\a\\AppData\\Local\\charsiu\\models");
        assert_eq!(z.sysdir.as_deref(), Some("/opt/charsiu/models"));
        assert_eq!(z.current.as_deref(), Some("/x/y.gguf"));
        assert_eq!(z.rows.len(), 4);
        assert_eq!(z.rows[1].total_mb(), 279);
        let chat: Vec<_> = z
            .rows
            .iter()
            .filter(|r| r.is_chat())
            .map(|r| r.name.as_str())
            .collect();
        assert_eq!(chat, vec!["smollm2-135m-q4", "smolvlm-256m"]);
    }

    #[test]
    fn model_files() {
        assert!(is_model_file("Llama-3.2-1B-Instruct-Q8_0.gguf"));
        assert!(!is_model_file("Llama-3.2-1B-Instruct-Q8_0.gguf.wcache"));
        assert!(!is_model_file("x.gguf.part"));
        assert!(!is_model_file("mmproj-SmolVLM-256M-Instruct-Q8_0.gguf"));
    }

    #[test]
    fn sse_split_across_reads() {
        let mut s = Sse::default();
        assert!(s.feed(b"data: {\"a\":").is_empty());
        let v = s.feed(b"1}\n\ndata: [DONE]\r\n\nevent: x\n");
        assert_eq!(v, vec!["{\"a\":1}".to_string(), "[DONE]".to_string()]);
    }

    #[test]
    fn sse_utf8_split() {
        // a multi-byte character split between two reads survives
        let bytes = "data: 叉烧\n".as_bytes();
        let mut s = Sse::default();
        assert!(s.feed(&bytes[..8]).is_empty());
        assert_eq!(s.feed(&bytes[8..]), vec!["叉烧".to_string()]);
    }

    #[test]
    fn dechunk() {
        let mut d = Dechunk::default();
        let mut out = d.feed(b"5\r\nhel");
        out.extend(d.feed(b"lo\r\n6;x=1\r\n world\r"));
        out.extend(d.feed(b"\n0\r\n\r\n"));
        assert_eq!(out, b"hello world");
        assert!(d.done);
    }
}
