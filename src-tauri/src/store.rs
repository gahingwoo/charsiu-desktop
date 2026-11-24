// SPDX-License-Identifier: GPL-2.0-only
//
// Settings and conversations, as JSON files in the app's data directory
// (%APPDATA%\com.gahingwoo.charsiu-desktop on Windows,
// ~/.local/share/com.gahingwoo.charsiu-desktop on Linux). Written to a
// temporary file and renamed, so a crash mid-write keeps the old file.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
    Ok(d)
}

pub fn read(app: &AppHandle, name: &str) -> serde_json::Value {
    let Ok(d) = dir(app) else {
        return serde_json::Value::Null;
    };
    std::fs::read_to_string(d.join(name))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

pub fn write(app: &AppHandle, name: &str, v: &serde_json::Value) -> Result<(), String> {
    let d = dir(app)?;
    write_in(&d, name, v)
}

fn write_in(d: &Path, name: &str, v: &serde_json::Value) -> Result<(), String> {
    let f = d.join(name);
    let t = d.join(format!("{name}.tmp"));
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&t, s).map_err(|e| format!("{}: {e}", t.display()))?;
    std::fs::rename(&t, &f).map_err(|e| format!("{}: {e}", f.display()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        let d = std::env::temp_dir().join(format!("charsiu-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let v = serde_json::json!({"a": [1, 2], "zh": "叉烧"});
        super::write_in(&d, "x.json", &v).unwrap();
        super::write_in(&d, "x.json", &v).unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.join("x.json")).unwrap()).unwrap();
        assert_eq!(back, v);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
