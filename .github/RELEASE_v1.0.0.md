# Select Element v1.0.0

首个开源版本，聚焦 AI 辅助前端调试场景。

## Highlights

- 在真实网页中直接点选元素，快速采集 DOM Path、CSS Selector、XPath、尺寸、位置和文本摘要
- 支持 React / Vue 组件链识别，并在可用时附带源码线索
- 自动生成适合发给 Agent 的提示文本，减少手动整理页面上下文
- 提供 Side Panel、快捷键和悬浮球三种交互入口
- 支持记录历史、搜索、备注、JSON / Markdown / 提示文本复制与导出

## Install

1. 下载本版本的 zip 发布包并解压
2. 打开 `chrome://extensions/`
3. 开启右上角开发者模式
4. 点击“加载已解压的扩展程序”
5. 选择解压后的扩展目录

## Notes

- 当前通过 GitHub 分发，暂未上架 Chrome Web Store
- 无法在 `chrome://`、Chrome Web Store、扩展页等受限页面注入
- 默认只处理顶层文档，不支持跨域 iframe 内部元素采集

## Feedback

欢迎提交 Issue、功能建议和使用反馈。
