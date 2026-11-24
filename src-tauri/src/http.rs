// SPDX-License-Identifier: GPL-2.0-only
//
// The chat request, done here rather than in the webview: charsiu serve is a
// plain HTTP/1.1 server on 127.0.0.1, and a fetch from tauri://localhost
// (WebKitGTK) or http://tauri.localhost (WebView2) to it would depend on
// each engine's CORS and mixed-content rules. A socket of our own depends on
// neither. Stop closes the socket; charsiu stops generating when its next
// write fails.

use crate::parse::{Dechunk, Sse};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    /// the request is sent; the prompt is being read
    Sent,
    Token {
        text: String,
    },
    Done {
        finish: String,
    },
    Error {
        message: String,
    },
}

/// The socket of the request in flight, so cancel() can close it.
static INFLIGHT: Mutex<Option<TcpStream>> = Mutex::new(None);
static CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
    if let Some(s) = INFLIGHT.lock().unwrap().take() {
        let _ = s.shutdown(Shutdown::Both);
    }
}

struct Response {
    status: u16,
    chunked: bool,
    stream: TcpStream,
    rest: Vec<u8>,
}

fn request(
    port: u16,
    method: &str,
    path: &str,
    body: &str,
    track: bool,
) -> Result<Response, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("cannot reach charsiu serve on port {port}: {e}"))?;
    let _ = s.set_nodelay(true);
    // charsiu reads the whole prompt before it answers with headers, which
    // can take a while on a long conversation: Stop must work during that.
    if track {
        if let Ok(c) = s.try_clone() {
            *INFLIGHT.lock().unwrap() = Some(c);
        }
    }
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\nAccept: text/event-stream\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes())
        .and_then(|_| s.write_all(body.as_bytes()))
        .map_err(|e| format!("sending the request failed: {e}"))?;

    // the status line and headers
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 64 * 1024 {
            return Err("the reply's headers are too long".into());
        }
        let n = s
            .read(&mut tmp)
            .map_err(|e| format!("reading the reply failed: {e}"))?;
        if n == 0 {
            return Err("charsiu serve closed the connection without a reply".into());
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let rest = buf[end + 4..].to_vec();
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| "the reply has no status line".to_string())?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    Ok(Response {
        status,
        chunked,
        stream: s,
        rest,
    })
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

/// Read the whole body (small replies: /health, errors).
fn body_of(mut r: Response) -> Result<String, String> {
    let mut all = r.rest;
    let _ = r.stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = r.stream.read_to_end(&mut all);
    if r.chunked {
        all = Dechunk::default().feed(&all);
    }
    Ok(String::from_utf8_lossy(&all).to_string())
}

pub fn get_json(port: u16, path: &str) -> Result<serde_json::Value, String> {
    let r = request(port, "GET", path, "", false)?;
    let status = r.status;
    let b = body_of(r)?;
    if status != 200 {
        return Err(format!("HTTP {status}: {}", b.trim()));
    }
    serde_json::from_str(&b).map_err(|e| format!("not JSON: {e}"))
}

/// The message of an OpenAI-style error body, or the body itself.
fn error_message(status: u16, body: &str) -> String {
    let m = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string));
    match m {
        Some(m) => m,
        None if body.trim().is_empty() => format!("HTTP {status}"),
        None => format!("HTTP {status}: {}", body.trim()),
    }
}

/// One streamed chat completion. `emit` gets every event; returns when the
/// reply ends, fails, or is cancelled.
pub fn chat(port: u16, body: &str, emit: &dyn Fn(ChatEvent)) {
    CANCELLED.store(false, Ordering::SeqCst);
    let r = match request(port, "POST", "/v1/chat/completions", body, true) {
        Ok(r) => r,
        Err(e) => {
            INFLIGHT.lock().unwrap().take();
            if CANCELLED.load(Ordering::SeqCst) {
                return emit(ChatEvent::Done {
                    finish: "cancelled".into(),
                });
            }
            return emit(ChatEvent::Error { message: e });
        }
    };
    if r.status != 200 {
        let status = r.status;
        INFLIGHT.lock().unwrap().take();
        let b = body_of(r).unwrap_or_default();
        return emit(ChatEvent::Error {
            message: error_message(status, &b),
        });
    }
    emit(ChatEvent::Sent);

    let mut s = r.stream;
    let mut sse = Sse::default();
    let mut dechunk = r.chunked.then(Dechunk::default);
    let mut finish: Option<String> = None;
    let mut pending = r.rest;
    let mut tmp = [0u8; 8192];
    'read: loop {
        let bytes = match dechunk.as_mut() {
            Some(d) => d.feed(&pending),
            None => std::mem::take(&mut pending),
        };
        pending.clear();
        for data in sse.feed(&bytes) {
            if data == "[DONE]" {
                break 'read;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
                continue;
            };
            if let Some(m) = v["error"]["message"].as_str() {
                emit(ChatEvent::Error {
                    message: m.to_string(),
                });
                break 'read;
            }
            let c = &v["choices"][0];
            if let Some(t) = c["delta"]["content"].as_str() {
                if !t.is_empty() {
                    emit(ChatEvent::Token {
                        text: t.to_string(),
                    });
                }
            }
            if let Some(f) = c["finish_reason"].as_str() {
                finish = Some(f.to_string());
            }
        }
        match s.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => pending.extend_from_slice(&tmp[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    INFLIGHT.lock().unwrap().take();
    let was_cancelled = CANCELLED.load(Ordering::SeqCst);
    let _ = s.shutdown(Shutdown::Both);
    let finish = match finish {
        _ if was_cancelled => "cancelled".into(),
        Some(f) => f,
        None => "closed".into(),
    };
    emit(ChatEvent::Done { finish });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_bodies() {
        assert_eq!(
            error_message(
                400,
                "{\"error\":{\"message\":\"the conversation does not fit in 2048 tokens\"}}\n"
            ),
            "the conversation does not fit in 2048 tokens"
        );
        assert_eq!(error_message(404, ""), "HTTP 404");
        assert_eq!(error_message(500, "oops"), "HTTP 500: oops");
    }

    /// A stand-in server speaking exactly what charsiu_serve writes.
    #[test]
    fn stream_against_a_fake_server() {
        use std::net::TcpListener;
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut req = [0u8; 4096];
            let _ = c.read(&mut req);
            let mut out = String::from(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                 Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
            );
            for tok in ["Hel", "lo", " 叉烧"] {
                out += &format!(
                    "data: {{\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\
                     \"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{tok}\"}},\
                     \"finish_reason\":null}}]}}\n\n"
                );
            }
            out += "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
            for b in out.as_bytes().chunks(7) {
                c.write_all(b).unwrap();
            }
        });
        let got = Mutex::new(Vec::new());
        chat(port, "{}", &|e| {
            let s = match e {
                ChatEvent::Sent => "sent".to_string(),
                ChatEvent::Token { text } => format!("t:{text}"),
                ChatEvent::Done { finish } => format!("done:{finish}"),
                ChatEvent::Error { message } => format!("err:{message}"),
            };
            got.lock().unwrap().push(s);
        });
        t.join().unwrap();
        assert_eq!(
            *got.lock().unwrap(),
            vec!["sent", "t:Hel", "t:lo", "t: 叉烧", "done:stop"]
        );
    }
}
