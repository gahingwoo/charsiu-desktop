# 开发

[English](development.md)

## 工作原理

程序只是前端，不包含模型运行时。

- 启动 `charsiu serve --host 127.0.0.1 --port 0`，从 stderr 读取服务选定的端口（`charsiu_serve: ready on http://...`）。模型在多次提问之间保持加载，只有换模型时才重启（`CHARSIU_MODEL=<路径>`）。
- 每个问题是一次 `POST /v1/chat/completions`，带 `stream: true`。请求由 Rust 发出而不是网页视图，所以不涉及跨域规则。“停止”会关闭连接，charsiu 在下一次写入失败时停止生成。
- 模型列表来自 `charsiu pull --zoo`，下载用 `charsiu pull NAME`，它会校验文件，只有 charsiu 能运行时才保留。进度条按 `.part` 文件的大小显示。
- 每秒 token 数和首个 token 的时间由程序根据每个流式 token 到达的时间测量。
- Windows 上的 NPU 状态：`ACPI\RKCP3576\0` 的 PnP 状态和 rknpu.sys 的 `RK3576 NPU` 性能计数器（每个核心的忙碌时间）。Linux 上：accel 节点、rocket 模块、每个核心的运行时电源状态和 NPU 电源轨。
- Windows 上服务通过 `charsiu.ps1` 启动（powershell.exe，然后 charsiu_serve.exe），两者放进一个作业对象，随程序一起结束。Linux 上服务在自己的进程组中运行，程序退出时停止。
- 对话和设置是程序数据目录中的 JSON 文件（`%APPDATA%\com.gahingwoo.charsiu-desktop`、`~/.local/share/com.gahingwoo.charsiu-desktop`）。导出时写一个 Markdown 文件（标题、日期、每一轮对话，代码块保持原样），保存到保存对话框选择的位置。

使用 Tauri 2 和系统网页视图（Windows 11 上是 WebView2，Linux 上是 WebKitGTK），因为开发板只有 4 GB 内存，charsiu 需要其中大部分。页面使用 React 和 [PatternFly Chatbot](https://www.patternfly.org/patternfly-ai/chatbot/overview) 扩展，布局沿用其 “Fullscreen chatbot with docked navigation” 示例。消息栏下方的页脚显示后端、NPU 和 tokens/s，弹出框中有端口、模型、NPU 驱动状态、每个核心的忙碌数据和上一次回答的速度。设置项：模型、模型文件、主题、语言、回答设置、charsiu 程序、重启、报告问题、关于。“关于”框、“报告问题”（日志中去掉个人信息）、主题（深色跟随系统）和文字选择规则与 Maskrom Studio 共用。界面文字在 `src/messages.ts`。

## 构建

页面需要 Node 22 和 npm，程序需要 Rust（stable）和 Tauri CLI：

```
npm ci                 # 按 package-lock.json 校验每个包
npm run typecheck
npm run build          # esbuild，输出到 dist/（Tauri 会嵌入）
cargo install tauri-cli --version =2.12.6 --locked
cd src-tauri
cargo tauri build --bundles deb                                    # Linux arm64
cargo tauri build --target aarch64-pc-windows-msvc --bundles nsis  # Windows arm64
```

Linux 需要 `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libsoup-3.0-dev`，Windows 需要 Visual Studio 的 ARM64 构建工具。没有 MSI，因为 WiX 不能构建 arm64 安装包。Debian 包名为 `charsiu-desktop`，以免与它所运行的 `charsiu` 包冲突。

`python3 tools/make-icons.py` 重新绘制图标。

## CI

`.github/workflows/build.yml` 在每次推送和拉取请求时运行：

- 构建页面和两个安装包；
- `cargo test`：stderr 分类、zoo 解析、SSE 分帧、对模拟服务器的一次流式回答；
- lint 作业中运行 `cargo fmt --check`。“Apply rustfmt” 工作流（`fmt.yml`，手动运行）会格式化并提交；
- `screenshots` 作业在 Chrome 中针对 `scripts/mock-tauri.js`（程序命令的模拟）渲染页面。本地运行：`npm run shots`，用 `CHROME=` 指向 Chrome。

README 截图：`npm run readme-shots` 以 WebP 格式写到 `docs/imgs`。每次推送都会上传一套新的截图作为 `readme-images` 产物，“Update README pictures” 工作流（`readme-shots.yml`，手动运行）渲染并提交它们。

演示动图：`npm run demo-gif`（需要 PATH 中有 `ffmpeg`）。“README walkthrough GIF” 工作流（`demo-gif.yml`）在每次推送到 main 时录制英文和中文两份，作为 `readme-media` 分支的唯一提交强制推送，不进入 main 的历史。

## 发布

每次推送到 main 并构建成功后，三个安装包会原地发布到 `ci` 预发布版（`.github/scripts/ci-release.sh`：用 `--clobber` 上传，合并 SHA256SUMS.txt，移动标签，然后只删除被新文件替换的旧包；预发布版本身从不删除）。

正式发布：在 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 中设置版本，推送，再推送标签 `vX.Y.Z`。CI 检查标签与版本一致，然后发布 vX.Y.Z，附带安装包和 SHA256SUMS.txt（如果该版本先手动创建过，则添加并替换文件）。

## 在开发板上测试

需要支持 `charsiu pull --zoo` 和 `charsiu serve --port 0` 的 charsiu。

Windows（泰山派 3M，Windows 11 23H2 arm64）：

1. 安装 charsiu（README“安装”中的命令，或发布说明中指定的分支构建）。在新终端中检查 `charsiu "hello"`。
2. 从 `charsiu-desktop-windows-arm64` 产物运行 `Charsiu Desktop_<版本>_arm64-setup.exe`。WebView2 是 Windows 11 自带的。
3. 启动 Charsiu Desktop。页脚先显示“Loading the model”，然后“Ready · NPU in use, 2 cores”。回答时弹出框中显示端口、模型、“driver started”和每个核心的忙碌数据（需要已注册计数器，见 woa-rk3576-npu 的 docs/PERFCOUNTERS.md）。模型第一次启动约一分钟，之后几秒。
4. 提问或点击欢迎提示。检查：输入指示器、回答流式出现、“停止”在一两个 token 内结束、复制和重新生成可用、代码块有自己的复制按钮、页脚显示 tokens/s（Llama 3.2 1B 实测 14 到 16）、每个回答下有首个 token 时间。如果 config.ini 指定了模型文件夹之外的模型（例如 `R:\npu\Llama-3.2-1B-Instruct-Q8_0.gguf`），“设置”、“模型”会把它列为配置中的模型。
5. 对话：打开抽屉，新建对话，搜索、重命名、删除；重启程序后检查对话仍在。
6. 模型：下载 smollm2-135m-q4（92 MB），观察进度，使用它，检查后端用它重启，然后删除。
7. 以没有 NPU 设备权限的用户运行（除非安装脚本另行设置，rknpu.sys 只允许管理员），应看到“The NPU needs administrator rights”，回答由 CPU 完成。
8. “设置”、“报告问题”：日志中用户文件夹显示为 ~，按钮在浏览器中打开 GitHub issue。
9. 关闭程序，任务管理器中没有残留的 charsiu_serve.exe 或 powershell.exe。

Linux（带 rocket 的 Armbian edge，或任何装有 charsiu 的 arm64 Debian/Ubuntu）：

1. `sudo apt install charsiu`（Armbian）或 charsiu 的安装脚本，然后 `charsiu "hello"`。
2. 从 `charsiu-desktop-linux-arm64-deb` 产物 `sudo apt install ./charsiu-desktop_<版本>_arm64.deb`。
3. 重复 Windows 的第 3 到 6 步。回答时 NPU 显示“rocket driver loaded, 2 of 2 cores active”。
4. 关闭程序，`pgrep -a charsiu_serve` 没有输出。
