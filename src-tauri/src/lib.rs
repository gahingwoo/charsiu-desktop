// SPDX-License-Identifier: GPL-2.0-only
//
// charsiu desktop: a chat window over `charsiu serve`.

mod backend;
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
}

#[tauri::command]
fn app_info(app: AppHandle) -> Info {
    Info {
        os: std::env::consts::OS.into(),
        version: app.package_info().version.to_string(),
        charsiu: proc::charsiu_path("")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
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
    blocking(move || {
        http::chat(port, &body, &|e| {
            let _ = on_event.send(e);
        })
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

pub fn run() {
    tauri::Builder::default()
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
