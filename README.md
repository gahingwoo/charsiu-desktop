# charsiu desktop

A chat window for [charsiu](https://github.com/gahingwoo/charsiu), the open
LLM runtime for the RK3576 NPU. The same app runs on Windows on Arm (the NPU
through rknpu.sys, from
[woa-rk3576-npu](https://github.com/gahingwoo/woa-rk3576-npu)) and on Linux
(the NPU through the mainline rocket driver). Only the charsiu underneath
differs.

## How it works

The app is a front end and nothing more. It does not contain a model runtime.

- It starts `charsiu serve --host 127.0.0.1 --port 0` and reads the port the
  server picked from its stderr (`charsiu_serve: ready on http://...`). The
  model stays loaded between questions; it is restarted only when you pick
  another model (`CHARSIU_MODEL=<path>`).
- Each question is one `POST /v1/chat/completions` with `stream: true`,
  charsiu's OpenAI compatible endpoint. The request is made from Rust, not
  from the web view, so neither WebView2's nor WebKitGTK's cross-origin rules
  are involved. Stop closes the connection, and charsiu stops generating when
  its next write fails.
- Models are listed with `charsiu pull --zoo` and downloaded with
  `charsiu pull NAME`, which verifies the file and keeps it only if charsiu
  can run it. The progress bar is the size of the `.part` file it writes.
- Tokens per second and the time to the first token are measured in the app
  from when each streamed token arrives.
- NPU state: on Windows, the PnP state of `ACPI\RKCP3576\0` and rknpu.sys's
  `RK3576 NPU` performance counters (busy time per core); on Linux, the accel
  node, the rocket module, each core's runtime power state and the NPU rail.
- On Windows the front door is `charsiu.ps1`, so the server runs as
  powershell.exe then charsiu_serve.exe. Both go into a job object that is
  killed with the app. On Linux the server runs in its own process group,
  stopped when the app quits.
- Conversations and settings are JSON files in the app's data directory
  (`%APPDATA%\com.gahingwoo.charsiu-desktop`,
  `~/.local/share/com.gahingwoo.charsiu-desktop`).

Tauri 2 with the system web view (WebView2 on Windows 11, WebKitGTK on
Linux), because the board has 4 GB of memory and charsiu needs most of it.
The page is plain HTML, CSS and JavaScript with no build step, styled with
PatternFly 6 (`ui/vendor`, built by `tools/patternfly/build.sh`). English and
Simplified Chinese.

## Build

Rust (stable) and the Tauri CLI:

```
cargo install tauri-cli --version =2.12.6 --locked
cd src-tauri
cargo tauri build --bundles deb                                    # Linux arm64
cargo tauri build --target aarch64-pc-windows-msvc --bundles nsis  # Windows arm64
```

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
libsoup-3.0-dev`. Windows needs Visual Studio's ARM64 build tools. MSI is not
offered: WiX does not build arm64 installers. The product is called Charsiu
Desktop so its Debian package (`charsiu-desktop`) does not collide with the
`charsiu` package it runs. CI (`.github/workflows/build.yml`)
builds both and runs the tests (`cargo test`: the stderr classifier, the zoo
parser, SSE framing, a streamed reply against a stand-in server).

`python3 tools/make-icons.py` redraws the icons; `sh tools/patternfly/build.sh`
rebuilds the PatternFly CSS.

## Testing on the board

The app needs a charsiu new enough to have `charsiu pull --zoo` and
`charsiu serve --port 0`.

Windows (TaishanPi 3M, Windows 11 23H2 arm64):

1. Install charsiu: `irm https://raw.githubusercontent.com/gahingwoo/woa-rk3576-npu/main/win/charsiu-install.ps1 | iex`
   (or the branch build the release notes name). Check `charsiu "hello"` in a
   new terminal.
2. Run the installer `Charsiu Desktop_0.1.0_arm64-setup.exe` from the
   `charsiu-desktop-windows-arm64` artifact. It installs for the current user;
   WebView2 is already part of Windows 11.
3. Start Charsiu Desktop from the Start menu. Expected: Backend "loading the model",
   then "ready (127.0.0.1:PORT)"; NPU "in use, 2 cores, driver started" and
   the per-core busy figures while a reply is written (if the counters are
   registered, see woa-rk3576-npu docs/PERFCOUNTERS.md). The first start of a
   model takes about a minute (quantising, writing the weight cache); later
   starts a few seconds.
4. Ask something; check the reply streams, Stop ends it within a token or
   two, Copy works, the status line shows tokens/s (M7 measured 14 to 16 on
   Llama 3.2 1B) and the first-token time.
5. Models: download smollm2-135m-q4 (92 MB), watch the progress, Use it, and
   check the backend restarts with it. Remove it again.
6. As a user without access to the NPU device (rknpu.sys admits
   administrators only unless the installer set it otherwise), expect the
   warning "The NPU needs administrator rights" and replies on the CPU.
7. Close the app and check in Task Manager that no charsiu_serve.exe or
   powershell.exe is left.

Linux (Armbian edge with rocket, or any arm64 Debian/Ubuntu with charsiu):

1. `sudo apt install charsiu` (Armbian) or charsiu's installer, then
   `charsiu "hello"`.
2. `sudo apt install ./charsiu-desktop_0.1.0_arm64.deb` from the
   `charsiu-desktop-linux-arm64-deb` artifact.
3. Start Charsiu Desktop from the menu and repeat steps 3 to 5 above. NPU shows
   "rocket driver loaded, 2 of 2 cores active" while it answers.
4. Close it and check `pgrep -a charsiu_serve` prints nothing.

## Licence

GPL-2.0-only. PatternFly (ui/vendor) is MIT.
