# Charsiu Desktop

[English](README.md)

[charsiu](https://github.com/gahingwoo/charsiu) 的聊天窗口。charsiu 是在 RK3576 NPU 上运行大模型的运行时。模型在开发板上运行，对话保存在开发板上，模型下载好之后不需要联网。同一个程序可在 Windows on Arm 和 Linux 上运行。

![提问、流式回答、复制回答、导出为 Markdown 和对话历史](https://github.com/gahingwoo/charsiu-desktop/raw/readme-media/demo-zh-CN.gif)

| | |
|---|---|
| ![带代码块的对话](docs/imgs/chat-en.webp) | ![欢迎提示](docs/imgs/welcome-zh.webp) |
| ![对话历史](docs/imgs/history-zh.webp) | ![深色主题](docs/imgs/dark-zh.webp) |

## 状态

| 功能 | 状态 |
|---|---|
| 流式对话、停止、复制、重新生成 | 仅 CI |
| 对话历史（本地保存、搜索、重命名、删除） | 仅 CI |
| 将对话导出为 Markdown | 仅 CI |
| 模型列表与下载（`charsiu pull`） | 仅 CI |
| 页脚中的 NPU 状态（Windows 和 Linux） | 仅 CI |
| 英文和简体中文 | 仅 CI |

## 运行环境

- 装有 charsiu 的 RK3576 开发板。模型可以在“设置”、“模型文件”中下载。
- Windows 11 arm64，装有 rknpu 驱动（[woa-rk3576-npu](https://github.com/gahingwoo/woa-rk3576-npu)），或者 Linux arm64，使用主线的 rocket 驱动（Armbian 的 edge 内核已包含）。

没有 NPU 驱动时，charsiu 用 CPU 回答，慢好几倍，程序会给出提示。

## 安装

Windows：

1. 安装 charsiu。Maskrom Studio 会安装 RK3576 工具包（其中带有 charsiu：`%ProgramFiles%\RK3576\npu`，`charsiu` 命令在 Path 上）和本程序。没有工具包时，在 PowerShell 中安装，第一次以管理员身份运行，这样普通用户也能使用 NPU：
   `irm https://raw.githubusercontent.com/gahingwoo/woa-rk3576-npu/main/win/charsiu-install.ps1 | iex`
2. 从[最新版本](https://github.com/gahingwoo/charsiu-desktop/releases/latest)运行 `charsiu-desktop_<版本>_arm64-setup.exe`，它安装到当前用户。

两种安装之后都要重启一次，普通用户才能使用 NPU。在那之前程序用 CPU 回答，并提供“以管理员身份重新启动”。

Linux：

1. Armbian 上 `sudo apt install charsiu`，其他系统用 charsiu 的安装脚本。
2. 从[最新版本](https://github.com/gahingwoo/charsiu-desktop/releases/latest)下载后 `sudo apt install ./charsiu-desktop_<版本>_arm64.deb`，或使用 `charsiu-desktop_<版本>_aarch64.AppImage`。

用 `SHA256SUMS.txt` 校验下载的文件（`sha256sum -c SHA256SUMS.txt --ignore-missing`，Windows 上用 `Get-FileHash`）。main 的最新构建（未在开发板上测试）是 [ci 预发布版](https://github.com/gahingwoo/charsiu-desktop/releases/tag/ci)。

一个模型第一次启动大约需要一分钟（charsiu 要写权重缓存），之后只需几秒。

对话和设置是 JSON 文件，位于 `%APPDATA%\com.gahingwoo.charsiu-desktop`（Windows）或 `~/.local/share/com.gahingwoo.charsiu-desktop`（Linux）。不会上传任何内容。

工作原理、构建、CI、发布和开发板测试清单见 [docs/development.zh-CN.md](docs/development.zh-CN.md)。

## 许可证

GPL-2.0-only。PatternFly 和 PatternFly Chatbot 为 MIT 许可，构建时打包进 dist/（许可声明见 dist/app.js.LEGAL.txt）。
