# Select Element

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)

一个面向 AI 前端调试工作流的 Chrome Extension Manifest V3 扩展。

它的目标不是单纯抓 DOM，而是让你在真实网页里点一下元素，就把足够准确的结构化信息交给 Agent，帮助快速定位和修改对应组件。你可以把它理解为一种运行在 Chrome 里的、类似 Cursor 内置浏览器工作流的开源轻量替代方案。

## 功能特性

- 在真实网页中直接点选元素，快速采集 DOM Path、CSS Selector、XPath、尺寸、位置和摘要信息
- 支持 React / Vue 组件链识别，并在可用时附带源码线索，方便 Agent 更快回到项目代码
- 自动生成适合发给 Agent 的提示文本，减少手动整理上下文
- 侧边栏中文界面，支持开始选择、停止选择、复制、导出 JSON、清空记录
- 网页内悬浮高亮框和中文提示文案
- **悬浮球（FAB）**：注入 Shadow DOM，不受宿主页面样式污染；支持拖拽改变位置，点击展开快捷菜单
- 使用 `chrome.storage.local` 持久化保存，最多保留 200 条记录
- 支持搜索、备注、复制 JSON、复制 Markdown、单条删除、批量清空、导出 JSON

## 分发方式

当前推荐通过 GitHub 分发，暂不依赖 Chrome Web Store。

- 方式一：直接下载源码仓库，然后加载已解压扩展
- 方式二：从 GitHub Releases 下载打包好的发布包 zip，解压后加载已解压扩展

注意：通过 GitHub 分发时，Chrome 仍然需要通过 `chrome://extensions/` 的开发者模式手动加载，不能像 Chrome Web Store 一样一键安装。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt + Shift + S` | 开始选择模式 |
| `Alt + Shift + X` | 停止选择模式 |
| `ESC` | 退出选择模式（选择模式激活时有效） |

> 快捷键可在 `chrome://extensions/shortcuts` 中自定义。

## 项目结构

```
├── manifest.json        # MV3 清单配置，包含权限、快捷键、图标
├── service-worker.js    # 后台：消息处理、内容脚本注入、状态同步、记录保存
├── sidepanel.html       # 侧边栏结构
├── sidepanel.css        # 侧边栏样式（Shadcn/UI 极简风格）
├── sidepanel.js         # 侧边栏交互逻辑
├── content-script.js    # 网页侧：选择模式、高亮、快照采集、FAB 悬浮球
├── content-style.css    # 网页叠加层样式（高亮框、提示条）
├── utils.js             # 通用常量、存储与格式化工具
└── icon/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 安装方式

### 方式一：从 GitHub 源码安装

1. 下载或克隆当前仓库
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启右上角"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择当前项目目录

### 方式二：从 GitHub Release 安装

1. 在 GitHub Releases 下载 `select-element-v<version>.zip`
2. 将 zip 解压到本地目录
3. 打开 Chrome，进入 `chrome://extensions/`
4. 开启右上角"开发者模式"
5. 点击"加载已解压的扩展程序"
6. 选择解压后的 `select-element-v<version>` 目录

## 使用方式

### 通过侧边栏
1. 点击扩展图标，打开侧边栏
2. 点击"开始选择"
3. 在页面上移动鼠标，高亮框跟随元素
4. 点击目标元素完成采集

### 通过悬浮球（FAB）
- 可在侧边栏中切换悬浮球模式（关闭 / 仅当前页 / 所有网页）
- 点击悬浮球展开菜单，可"开始选择" / "停止选择" / "关闭悬浮球"
- 按住悬浮球上下拖动可改变位置
- 选择模式激活时悬浮球变为绿色并显示状态指示点

### 通过快捷键
- 使用 `Alt+Shift+S` / `Alt+Shift+X` 直接触发，无需打开侧边栏

## 已知限制

- 无法在 `chrome://`、Chrome Web Store、扩展页等受限页面注入
- 默认只处理顶层文档，不支持跨域 iframe 内部元素采集
- `outerHTML` 会进行长度截断，避免单条记录过大

## 开源与发布建议

- 源码仓库用于展示完整项目、文档和 issue 协作
- GitHub Releases 用于放置用户可直接下载的发布包 zip
- 建议每次发布时使用语义化版本号，并同步更新 `manifest.json`

## 许可证

本项目以 [CC BY-NC 4.0](LICENSE) 协议开源。允许查阅源码、修改和二次开发，**不可用于商业用途**。
