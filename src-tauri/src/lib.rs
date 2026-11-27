// SPDX-License-Identifier: GPL-2.0-only
//
// charsiu desktop: a chat window over `charsiu serve`.

mod backend;
mod elevate;
mod export;
mod http;
mod models;
mod npu;
mod parse;
mod proc;
mod store;

use backend::{Backend, Snapshot};
use http::ChatEvent;
use models::{Models, Pull, PullRequest, PullStatus};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, State};

#[derive(Default)]
struct App {
    backend: Backend,
    pull: Pull,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    os: String,
    version: String,
    /// the front door the app would use with no override, or empty
    charsiu: String,
    /// the home folder and the user name, which "Report a problem" removes
    /// from the log before anything leaves the computer
    home: String,
    user: String,
    /// Windows: this app runs as administrator (it then gets the NPU even
    /// before UserAccess takes effect)
    elevated: bool,
}

#[tauri::command]
fn app_info(app: AppHandle) -> Info {
    Info {
        os: std::env::consts::OS.into(),
        version: app.package_info().version.to_string(),
        charsiu: proc::charsiu_path("")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        home: std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
        user: std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_default(),
        elevated: elevate::is_elevated(),
    }
}

/// Start this app again as administrator (a UAC prompt), and quit this
/// one when Windows says it started (elevate.rs).
#[tauri::command]
fn relaunch_as_admin(app: AppHandle) -> Result<(), String> {
    elevate::relaunch()?;
    app.exit(0);
    Ok(())
}

/// Open a link in the system's browser. Only https links to the places the
/// app itself names (its issues page, its sources, the author's site).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    const ALLOWED: [&str; 3] = [
        "https://github.com/gahingwoo/",
        "https://gahingwoo.com",
        "https://www.patternfly.org/",
    ];
    if !ALLOWED.iter().any(|a| url.starts_with(a)) || url.contains(['"', '\'', '`', '\n']) {
        return Err(format!("not a link the app opens: {url}"));
    }
    #[cfg(windows)]
    let r = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
    };
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn backend_state(st: State<App>) -> Snapshot {
    st.backend.snapshot()
}

#[tauri::command]
fn backend_log(st: State<App>) -> Vec<String> {
    st.backend.log()
}

#[tauri::command]
async fn backend_start(
    app: AppHandle,
    charsiu: String,
    model: Option<String>,
) -> Result<(), String> {
    let b = app.state::<App>().backend.clone();
    let model = model.filter(|m| !m.is_empty());
    blocking(move || b.start(&app, &charsiu, model)).await
}

#[tauri::command]
async fn backend_stop(app: AppHandle) -> Result<(), String> {
    let b = app.state::<App>().backend.clone();
    blocking(move || b.stop(&app)).await
}

/// One streamed reply. `body` is the OpenAI request as the page built it.
#[tauri::command]
async fn chat(app: AppHandle, body: String, on_event: Channel<ChatEvent>) -> Result<(), String> {
    let port = app
        .state::<App>()
        .backend
        .port()
        .ok_or_else(|| "charsiu serve is not ready".to_string())?;
    let b = app.state::<App>().backend.clone();
    blocking(move || {
        let answered = std::sync::atomic::AtomicBool::new(false);
        let r = http::chat(port, &body, &|e| {
            if matches!(e, ChatEvent::Token { .. }) {
                answered.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            let _ = on_event.send(e);
        });
        // a reply came back, so the server is ready, whatever its stderr said
        if answered.load(std::sync::atomic::Ordering::Relaxed) {
            b.answered(&app);
        }
        r
    })
    .await
}

#[tauri::command]
fn chat_cancel() {
    http::cancel();
}

#[tauri::command]
async fn models_list(charsiu: String) -> Result<Models, String> {
    blocking(move || models::list(&charsiu)).await?
}

#[tauri::command]
async fn model_remove(charsiu: String, file: String) -> Result<(), String> {
    blocking(move || models::remove(&charsiu, &file)).await?
}

#[tauri::command]
fn pull_start(st: State<App>, charsiu: String, req: PullRequest) -> Result<(), String> {
    st.pull.start(&charsiu, req)
}

#[tauri::command]
fn pull_status(st: State<App>) -> PullStatus {
    st.pull.status()
}

#[tauri::command]
async fn pull_cancel(app: AppHandle) -> Result<(), String> {
    let p = app.state::<App>().pull.clone();
    blocking(move || p.cancel()).await
}

#[tauri::command]
async fn npu_status() -> Result<npu::NpuStatus, String> {
    blocking(npu::status).await
}

#[tauri::command]
fn load_data(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "settings": store::read(&app, "settings.json"),
        "conversations": store::read(&app, "conversations.json"),
    })
}

#[tauri::command]
fn save_settings(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    store::write(&app, "settings.json", &value)
}

#[tauri::command]
fn save_conversations(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    store::write(&app, "conversations.json", &value)
}

/// Save a conversation, already Markdown, where the user picks. The
/// dialog blocks, so not on the main thread: an async command.
#[tauri::command]
async fn export_markdown(
    app: AppHandle,
    title: String,
    name: String,
    text: String,
) -> Result<Option<String>, String> {
    blocking(move || export::save(&app, &title, &name, &text)).await?
}

pub fn run() {
    elevate::wait_for_previous();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(App::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            backend_state,
            backend_log,
            backend_start,
            backend_stop,
            chat,
            chat_cancel,
            models_list,
            model_remove,
            pull_start,
            pull_status,
            pull_cancel,
            npu_status,
            load_data,
            save_settings,
            save_conversations,
            export_markdown,
            open_url,
            relaunch_as_admin,
        ])
        .build(tauri::generate_context!())
        .expect("charsiu desktop failed to start")
        .run(|app, ev| {
            if let RunEvent::Exit = ev {
                // the server holds the NPU and gigabytes of memory: never
                // leave it behind
                http::cancel();
                let st = app.state::<App>();
                st.pull.cancel();
                st.backend.stop(app);
            }
        });
}
