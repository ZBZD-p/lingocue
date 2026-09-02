# LingoCue

> 面向中文用户的 YouTube 字幕英语学习助手

[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-lightgrey.svg)
[![YouTube extension](https://img.shields.io/badge/YouTube-Chrome%20extension-red.svg)](extension)

LingoCue 是一个面向中文用户的 Windows 英语学习工具，通过 YouTube 字幕帮助你进行听力练习、单词积累和语境学习。
它会跟随视频播放自动高亮字幕，支持单词查询、生词本、难度标记和 AI 对话。
视频仍然由 YouTube 播放，LingoCue 只在旁边提供学习工具。

LingoCue is a Windows desktop app and Chrome extension for learning English
with YouTube subtitles, vocabulary lookup, and personalized video difficulty analysis.

> 目前仅支持 Windows。

<p align="center">
  <img src="docs/demo.gif" alt="LingoCue YouTube 字幕学习侧边栏演示" width="820">
</p>

## 主要功能

- 跟随 YouTube 播放进度自动高亮字幕
- 点击单词查看释义、发音和词性
- 保存单词和短语到生词本
- 显示字幕难度和考试词汇标签
- 根据视频难度和你的词汇掌握情况，智能判断当前视频是否适合学习
- 循环播放单句或一段字幕
- 使用 AI 解释当前字幕和短语
- 支持中英字幕对照
- 支持独立面板和 Jellyfin 本地媒体库
- 只下载字幕，不下载 YouTube 视频

## 智能学习适配

LingoCue 不只是统计视频里有多少生词，还会把视频内容难度和你的个人词汇掌握情况结合起来分析。

<p align="center">
  <img src="docs/learning-fit.png" alt="LingoCue 根据视频难度和用户词汇量给出学习建议" width="820">
</p>

它会综合以下信息：

- 视频字幕中的词汇难度和生词数量
- 生词在视频中重复出现的次数
- 你已经掌握、正在学习和还不熟悉的词汇
- 视频的整体语速和每分钟的学习挑战度

启动视频后，LingoCue 会给出当前视频的学习提示。例如：视频中有 `34` 个可能不认识的词，其中 `4` 个会重复出现，当前挑战度为每分钟 `14.6` 个词。重复出现的词更适合通过上下文反复巩固；如果陌生词太密集，系统会提示这个视频可能更适合先直接观看，或换一个难度更合适的内容。

这个判断不是简单的“适合 / 不适合”二选一，而是帮助你决定应该怎样看：

- **花 30 秒过一遍**：先快速熟悉重点词汇，再开始播放
- **直接看**：当前难度在可接受范围内，直接进入学习

随着你在 LingoCue 中查词、保存生词和完成复习，后续视频的建议会越来越贴近你的实际水平。

## 快速安装

### Windows 用户

从 [Releases](../../releases) 下载最新的 `LingoCue-Setup.exe`，双击运行即可。

安装程序会自动准备内置 Python、核心依赖、ffmpeg 和英语词典。安装完成后启动 `LingoCue.exe`。

### 从源码运行

```powershell
git clone https://github.com/ZBZD-p/lingocue.git
cd lingocue
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

启动后端：

```powershell
python app.py
```

然后打开 <http://127.0.0.1:8420>。

## Chrome 扩展安装

Chrome 不允许普通程序静默安装本地扩展，因此**首次使用必须手动加载一次**。

1. 打开 Chrome。
2. 在顶部地址栏输入 `chrome://extensions/` 并回车。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。某些 Chrome 版本会显示为“加载未打包的扩展程序”。
5. 选择 LingoCue 安装目录下的 `extension` 文件夹。请选择整个文件夹，不要选择其中的单个文件。
6. 保持 LingoCue 后端运行，打开任意 YouTube 视频。

默认安装目录通常是：

```text
%LOCALAPPDATA%\Programs\LingoCue\extension
```

扩展只需加载一次。更新 LingoCue 后，如果 Chrome 提示扩展文件发生变化，请回到 `chrome://extensions/`，点击扩展卡片上的刷新按钮，再刷新 YouTube 页面。

## 使用方式

### YouTube

启动 LingoCue 后打开 YouTube 视频。扩展会自动识别当前视频并加载字幕，侧边栏会跟随播放位置高亮。

### 独立面板

打开 <http://127.0.0.1:8420>，可以使用查词、生词本和 AI 对话功能。独立面板不需要浏览器扩展。

### Jellyfin

先复制并编辑配置文件：

```powershell
Copy-Item .\jellyfin_config.example.json .\jellyfin_config.json
```

填入 Jellyfin 地址和 API key 后，以管理员权限运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\inject.ps1
```

Jellyfin 升级后可能需要重新运行一次注入脚本。

## 对话引擎

设置页支持两种对话引擎，二选一即可：

- **DeepSeek API**：在设置页填写 API key，响应速度更快。
- **Claude Code CLI**：安装并登录 [Claude Code](https://claude.com/claude-code)。

字幕、查词、生词本和难度标记不依赖 AI 引擎。

## 依赖和可选功能

源码运行需要 Python 3.10+。本地媒体字幕提取需要 ffmpeg，安装脚本会自动准备。

如果希望为完全没有标点的 YouTube 自动字幕补标点，可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -WithPunctuation
```

该功能会额外下载约 1.4GB，安装后约占用 2.4GB 磁盘空间。

## 配置文件

复制对应的 `.example` 文件后再修改：

| 文件 | 用途 |
| --- | --- |
| `config.json` | 数据目录、字幕缓存、ffmpeg 和模型缓存位置 |
| `jellyfin_config.json` | Jellyfin 地址和 API key |
| `deepseek_config.json` | DeepSeek API key 和模型设置 |

用户数据默认保存在项目下的 `data/` 目录，包括生词本、短语本、词典和字幕缓存。

## 常见问题

### 扩展已经加载，但 YouTube 上没有侧边栏

请确认 LingoCue 后端正在运行、扩展已启用，并且当前打开的是 `youtube.com`。部分隐私或广告拦截扩展可能会阻止侧边栏注入。

### 修改代码后扩展没有更新

面板代码现在按顺序保存在 `panel-src/` 分片中，由 manifest 驱动构建。请修改分片后重新构建两个产物：

```powershell
python tools/build_panel.py
```

不要直接编辑 `static/tutor-panel.js` 或 `extension/tutor-panel.js`，因为下次构建会覆盖手工修改。提交前可用以下命令检查产物是否与分片一致：

```powershell
python tools/build_panel.py --check
```

也可以安装仓库提供的 pre-commit hook：

```powershell
Copy-Item .\tools\hooks\pre-commit .\.git\hooks\pre-commit
```

之后每次提交都会检查必须保持一致的文件；若检查失败，请先重新构建面板产物。

然后在 `chrome://extensions/` 页面刷新扩展，并刷新 YouTube 页面。

### 字幕抓取失败

YouTube 字幕接口可能会临时限流或发生变化。等待一段时间后重试，不要连续快速请求同一个视频。

## 项目状态

LingoCue 目前主要面向 Windows 用户。YouTube 字幕接口、Chrome 扩展行为和第三方 AI 服务可能随平台更新而变化。

## License

GPL-3.0，详见 [LICENSE](LICENSE)。
