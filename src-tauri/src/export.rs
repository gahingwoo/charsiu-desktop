// SPDX-License-Identifier: GPL-2.0-only
//
// "Export as Markdown": the system's save dialog, then the page's text
// written where the user chose. Nothing is sent anywhere.

use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Where the file went, or None when the dialog was cancelled.
pub type Saved = Result<Option<String>, String>;

/// The chosen path, with .md added when the user typed a name without it.
pub fn with_md(mut p: PathBuf) -> PathBuf {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("md") && !ext.eq_ignore_ascii_case("markdown") {
        let mut name = p.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push(".md");
        p.set_file_name(name);
    }
    p
}

/// Ask where to save `text`, as `name` to begin with, and write it there.
pub fn save(app: &AppHandle, title: &str, name: &str, text: &str) -> Saved {
    let Some(chosen) = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(name)
        .add_filter("Markdown", &["md"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let p = with_md(chosen.into_path().map_err(|e| e.to_string())?);
    std::fs::write(&p, text).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(Some(p.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::with_md;
    use std::path::PathBuf;

    #[test]
    fn adds_the_extension_only_when_missing() {
        let md = |p: &str| with_md(PathBuf::from(p)).display().to_string();
        assert_eq!(md("/tmp/a.md"), "/tmp/a.md");
        assert_eq!(md("/tmp/a.MD"), "/tmp/a.MD");
        assert_eq!(md("/tmp/a.markdown"), "/tmp/a.markdown");
        assert_eq!(md("/tmp/a"), "/tmp/a.md");
        assert_eq!(md("/tmp/v1.2"), "/tmp/v1.2.md");
        assert_eq!(md("/tmp/叉烧"), "/tmp/叉烧.md");
    }
}
