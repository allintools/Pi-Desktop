# Pi Desktop

当前源码版本：**1.0.1**（2026-10-14）。本仓库提供源码，构建方法见下方「开发」。

Windows / WSL 编码工作台，使用用户已有的 pi。Tauri 2、React、TypeScript、Tailwind、Rust；默认 Alpine 森林主题。

## 安装与首次使用

按下方「开发」步骤构建后，运行 `src-tauri/target/release/bundle/nsis/` 下的安装包。安装包不包含 Node、pi 或 Git，也不会自动升级它们。Windows 需要 WebView2；安装器可安装缺失的运行时。

每个执行环境需要 Node ≥22.19、兼容 pi（首个验证基线 1.1.0），编码项目还需要 Git。在 Windows 或相应 WSL 发行版、用户中安装：

```sh
npm install -g @earendil-works/pi-coding-agent@1.1.0
pi --version
git --version
```

首次启动进入「运行环境」，检测 Windows 和已安装的 WSL 发行版。可分别指定 Node 可执行文件及 pi CLI 的 `.js` 入口，再重新检测；Git 从该环境 PATH 检测。WSL 必须填写 Linux 路径，例如 `/home/me/work/project`；程序始终在所选发行版与用户中运行。Windows 与 WSL 各自使用自己的模型认证、pi 会话和配置。

1. 点击「添加项目」，选择环境和项目根目录，确认信任。
2. 新建任务。Git 项目默认从当前 HEAD 建立 `codex/` 分支及独立 worktree；源目录未提交内容不带入新任务。可选择直接使用原目录。
3. 使用「规划」读取和搜索，停止任务后切换「执行」。在模型设置完成 API Key 或 SDK 提供的 OAuth 登录，也可继续使用 CLI 已有认证。
4. 查看工具过程，在右侧打开文件、Monaco 编辑器、Diff 或交互终端。测试通过后暂存、提交。
5. 独立 worktree 的提交可通过 Git 面板带回目标分支。冲突可编辑解决并继续，或中止 cherry-pick。

依赖缺失、版本不兼容和检测失败会显示原因。不同于浏览器预览，实际文件、Git、终端和 AI 操作需要原生桌面程序。

## 会话与运行

- 项目分组、搜索、置顶、归档、恢复；「继续已有会话」读取 pi 原生历史，保留原工作目录。
- 会话分支可选择历史位置，默认保留工作目录，勾选独立工作区才创建 worktree。
- Markdown、图片、流式文本和思考、实时工具过程、模型与思考等级、上下文用量。
- 运行中可追加指令或排入后续消息；最多四个任务并行，其余排队。切换页面保留后台任务、编辑器及终端。
- 关闭窗口隐藏到托盘。托盘「停止任务并退出」或设置中的退出会清理应用拥有的进程。不会关闭整个 WSL 发行版。
- 异常退出后恢复已持久化历史，标记「运行中断，可继续」；用户主动继续，不自动重放修改命令。
- 归档保留历史和工作目录。删除 worktree 会检查占用、未提交改动及未合入提交。

规划模式通过 CLI 工具集合和后台白名单实现：只开放 `read、grep、find、ls`，禁用扩展及 MCP，拒绝 shell、斜杠命令以及命令生成的认证配置。切换模式会停止并重建运行时。右侧编辑器、Git 和终端是用户主动操作的工作区，不是规划智能体的工具。

## 配置与外观

设置支持当前环境用户 / 项目作用范围的技能、扩展、提示模板和包管理；资源可查看、启停、安装及移除。移除本地资源先备份到所属数据目录的 `desktop-resource-backups`。配置修改在新启动或重连的会话中生效。终端专属扩展 UI 会显示兼容限制。

MCP 使用 pi 自身的 stdio / streamable HTTP 配置与连接实现；设置提供 JSON 编辑、连接检查、认证和登出。保留配置未知字段，保存前检查外部修改，原子写入。用户 / 项目 MCP 配置分别保存。模型与认证按 SDK 支持的提供商操作，模型配置位于环境用户目录。

Alpine / Dark / Light、Flat / 3D、90–150% 缩放、森林 / 本机壁纸 / 无壁纸，以及透明度、背景模糊、磨砂、遮罩、低性能和减少透明效果设置均实时应用。沿用原 WSL Manager 视觉方案。壁纸导入校验并压缩，保存失败显示提示，损坏设置回退默认值。顶部固定，侧栏中部圆形按钮手动折叠；窄窗口打开工作区后可点击「返回对话」。

## 数据

pi 原生会话、配置和凭据保留在该环境的 pi 数据目录，默认 `~/.pi/agent`，支持 pi 自己的环境变量覆盖。桌面 SQLite 位于 Tauri 应用数据目录，Windows 通常为 `%APPDATA%\local.pi-desktop.app\metadata.sqlite3`，仅存项目、会话绑定、置顶 / 归档、worktree 和布局。正文和认证密钥不写入桌面数据库。外观独立存于 WebView localStorage 的 `pi-desktop.appearance.v1`。不要删除这些数据目录来卸载程序，除非确实不再需要历史和设置。

## 开发

需要 Node、Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。

```sh
npm ci
npm run desktop
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run package
```

`npm run dev` 仅提供界面预览。`npm run package` 生成 Windows x64 NSIS 安装器，位于 `src-tauri/target/release/bundle/nsis/`。锁文件固定本次依赖解析。

实现边界和协议见 [架构](docs/ARCHITECTURE.md)，依赖与素材来源见 [第三方说明](THIRD_PARTY_NOTICES.md)。首版不包含定时自动化、SSH、云端执行和完整 WSL 系统管理。
