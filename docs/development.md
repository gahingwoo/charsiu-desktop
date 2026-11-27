# Development

[简体中文](development.zh-CN.md)

## How it works

The app is a front end; it contains no model runtime.

- It starts `charsiu serve --host 127.0.0.1 --port 0` and reads the chosen
  port from stderr (`charsiu_serve: ready on http://...`). The model stays
  loaded between questions and is restarted only when you pick another model
  (`CHARSIU_MODEL=<path>`).
- Each question is one `POST /v1/chat/completions` with `stream: true`. The
  request is made from Rust, not the web view, so no cross-origin rules
  apply. Stop closes the connection; charsiu stops when its next write fails.
- Models are listed with `charsiu pull --zoo` and downloaded with
  `charsiu pull NAME`, which verifies the file and keeps it only if charsiu
  can run it. The progress bar follows the size of the `.part` file.
- Tokens per second and time to first token are measured in the app from the
  arrival of each streamed token.
- NPU state on Windows: the PnP state of `ACPI\RKCP3576\0` and rknpu.sys's
  `RK3576 NPU` performance counters (busy time per core). On Linux: the accel
  node, the rocket module, each core's runtime power state and the NPU rail.
- On Windows the server is started through `charsiu.ps1` (powershell.exe,
  then charsiu_serve.exe); both go into a job object that is killed with the
  app. The script is looked for in `%LOCALAPPDATA%\Programs\charsiu`
  (charsiu-install.ps1), then `%ProgramFiles%\RK3576\npu` (the RK3576
  tools), then on PATH (a `charsiu.ps1`, or the one above a
  `bin\charsiu.cmd`); Settings can name another. The script sets the NPU
  variables (`CHARSIU_NPU` and the rest) from the user's config, so the app
  sets none itself, and a config that turns the NPU off is obeyed.
- When the NPU admits only administrators (rknpu.sys reads UserAccess when
  the device starts, so until the restart after an install), the notice
  offers Restart as administrator: the app starts itself again through a
  UAC prompt with `--after-pid`, and the new one waits for the old one to
  exit (WebView2 will not share its data folder across elevations). On Linux the server runs in its own process group, stopped when the
  app quits.
- Conversations and settings are JSON files in the app's data directory
  (`%APPDATA%\com.gahingwoo.charsiu-desktop`,
  `~/.local/share/com.gahingwoo.charsiu-desktop`). Export writes a Markdown
  file (title, date, each turn, code blocks unchanged) to the path chosen in
  the save dialog.

Tauri 2 with the system web view (WebView2 on Windows 11, WebKitGTK on
Linux), because the board has 4 GB of memory and charsiu needs most of it.
The page is React with the
[PatternFly Chatbot](https://www.patternfly.org/patternfly-ai/chatbot/overview)
extension, laid out as its "Fullscreen chatbot with docked navigation" demo.
The footnote under the message bar shows backend, NPU and tokens/s; its
popover has the port, the model, the NPU driver state, per-core busy figures
and the last reply's speed. Settings: model, model files, theme, language,
reply settings, the charsiu program, restart, report a problem, about. The
About box, "Report a problem" (log scrubbed of personal details), the theme
(dark follows the system) and the text selection rules are shared with
Maskrom Studio. Strings are in `src/messages.ts`.

## Build

Node 22 and npm for the page, Rust (stable) and the Tauri CLI for the app:

```
npm ci                 # every package checked against package-lock.json
npm run typecheck
npm run build          # esbuild, into dist/ (Tauri embeds it)
cargo install tauri-cli --version =2.12.6 --locked
cd src-tauri
cargo tauri build --bundles deb                                    # Linux arm64
cargo tauri build --target aarch64-pc-windows-msvc --bundles nsis  # Windows arm64
```

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
libsoup-3.0-dev`. Windows needs Visual Studio's ARM64 build tools. There is
no MSI because WiX does not build arm64 installers. The Debian package is
`charsiu-desktop` so it does not collide with the `charsiu` package it runs.

`python3 tools/make-icons.py` redraws the icons.

## CI

`.github/workflows/build.yml` runs on every push and pull request:

- builds the page and both packages;
- `cargo test`: the stderr classifier, the zoo parser, SSE framing, a
  streamed reply against a stand-in server;
- `cargo fmt --check` in the lint job. The "Apply rustfmt" workflow
  (`fmt.yml`, run by hand) formats and commits;
- the `screenshots` job renders the page in Chrome against
  `scripts/mock-tauri.js`, a stand-in for the app's commands. Locally:
  `npm run shots` with `CHROME=` pointing at a Chrome.

README pictures: `npm run readme-shots` writes them to `docs/imgs` as WebP.
Every push uploads a fresh set as the `readme-images` artifact, and the
"Update README pictures" workflow (`readme-shots.yml`, run by hand) renders
and commits them.

The walkthrough GIF: `npm run demo-gif` (needs `ffmpeg` on the PATH). The
"README walkthrough GIF" workflow (`demo-gif.yml`) records it in English and
Chinese on every push to main and force-pushes them as the only commit of the
`readme-media` branch, so they never enter the history of main.

## Releases

Every push to main that builds publishes the three packages to the `ci`
pre-release in place (`.github/scripts/ci-release.sh`: upload with
`--clobber`, merge SHA256SUMS.txt, move the tag, then remove only the
packages the new set replaced; the release is never deleted).

For a release: set the version in `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, push, then push tag
`vX.Y.Z`. CI checks that the tag matches the version and publishes release
vX.Y.Z with the packages and SHA256SUMS.txt (if the release was made by hand
first, it adds and replaces files), with `docs/releases/vX.Y.Z.md` as its
notes when that file exists, then checks SHA256SUMS.txt against the digest
GitHub serves for each file.

## Testing on the board

Needs a charsiu with `charsiu pull --zoo` and `charsiu serve --port 0`.

Windows (TaishanPi 3M, Windows 11 23H2 arm64):

1. Install charsiu (the command under Install in the README, or the branch
   build the release notes name). Check `charsiu "hello"` in a new terminal.
2. Run `Charsiu Desktop_<version>_arm64-setup.exe` from the
   `charsiu-desktop-windows-arm64` artifact. WebView2 is part of Windows 11.
3. Start Charsiu Desktop. The footnote shows "Loading the model", then
   "Ready · NPU in use, 2 cores". Its popover shows the port, the model,
   "driver started" and per-core busy figures while a reply is written (if
   the counters are registered, see woa-rk3576-npu docs/PERFCOUNTERS.md).
   First start of a model about a minute, later starts a few seconds.
4. Ask something or click a welcome prompt. Check: typing indicator, the
   reply streams, Stop ends it within a token or two, Copy and Regenerate
   work, code blocks have a copy button, the footnote shows tokens/s (14 to
   16 measured on Llama 3.2 1B), first-token time under each reply. If
   config.ini names a model outside the models folder (for example
   `R:\npu\Llama-3.2-1B-Instruct-Q8_0.gguf`), Settings, Model lists it as the
   config's model.
5. Conversations: open the drawer, start a new chat, search, rename, delete;
   restart the app and check they are still there.
6. Models: download smollm2-135m-q4 (92 MB), watch the progress, Use it,
   check the backend restarts with it, then remove it.
7. As a user without access to the NPU device (rknpu.sys admits
   administrators only unless the installer set otherwise), expect "The NPU
   needs administrator rights" and replies on the CPU. Restart as
   administrator: a UAC prompt, the app comes back elevated and the footnote
   shows the NPU in use.
8. Settings, Report a problem: the log shows the user folder as ~, and the
   button opens a GitHub issue in the browser.
9. Close the app; Task Manager shows no charsiu_serve.exe or powershell.exe.

Linux (Armbian edge with rocket, or any arm64 Debian/Ubuntu with charsiu):

1. `sudo apt install charsiu` (Armbian) or charsiu's installer, then
   `charsiu "hello"`.
2. `sudo apt install ./charsiu-desktop_<version>_arm64.deb` from the
   `charsiu-desktop-linux-arm64-deb` artifact.
3. Repeat Windows steps 3 to 6. The NPU shows "rocket driver loaded, 2 of 2
   cores active" while it answers.
4. Close it; `pgrep -a charsiu_serve` prints nothing.
