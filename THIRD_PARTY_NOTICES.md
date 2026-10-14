# 第三方及素材说明

本项目依赖以各自包中的 LICENSE 为准。主要组件：React、Monaco Editor、xterm.js、Tailwind CSS、Vite、TypeScript、React Markdown、remark、portable-pty、rusqlite（MIT）；Tauri 及其插件（MIT / Apache-2.0）；Lucide 图标（ISC）。完整版本见 package-lock.json 和 src-tauri/Cargo.lock。

Node helper 在用户环境中加载 `@earendil-works/pi-coding-agent`，安装包不分发该 SDK 或 Node。pi 的使用和许可按用户安装版本执行。

主题模块和森林壁纸来自 [WSL Manager](https://github.com/allintools/WSL-Manager)。森林壁纸由内置 imagegen 生成，随后压缩为 WebP；未使用 Freebuff 品牌图像或文案。复制的 `public/wallpapers/alpine.webp` SHA256 为 `D3565A6837F57EE1B87257D27CED52B5D528724B6981FA8942B26F7C69B79DC4`。Pi Desktop 保留视觉方向并更换独立存储键、导航及业务适配。此复用不代表为原项目或素材重新授予开源许可，权利归属沿用原项目及素材。

Pi 几何应用图标由本次实现以 Pillow 绘制。
