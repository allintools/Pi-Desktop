# 架构与维护边界

```text
React 工作台 / ThemeProvider
  → Tauri IPC（命令与 desktop-events）
Rust core：SQLite、调度、RPC、Job Object、WSL 进程组、ConPTY、托盘
  → Windows：已有 Node / pi / Git
  → WSL：绑定发行版、用户和 Linux cwd 的 Node / pi / Git
Node helper：调用该环境已有 pi SDK；文件、Git、配置、认证、MCP
pi --mode rpc：每个打开的会话一个子进程
```

## 数据归属

`src/types.ts` 定义 RuntimeTarget / Project / SessionBinding（代码别名 Target / Session）和 DesktopEvent。项目同时绑定执行环境与规范化根路径，信任在绑定上保存。SQLite 保存桌面索引；原生会话 JSONL 和认证仍由 pi SDK 管理。恢复、重命名和历史分支直接操作 SDK 会话，避免维护第二套正文。

布局通过 `layout_save` 写入 SQLite。外观设置使用独立版本化 localStorage；运行时路径偏好另存，不含认证信息。配置保存合并未知顶层字段，内容修订校验避免覆盖外部修改，临时文件替换实现原子保存。

## RPC 与调度

Rust 直接启动已安装 pi 的 CLI，按 LF 读取 stdout JSONL，UTF-8 和 CRLF 可跨读块；stderr 独立消费并保留有限尾部。单条记录上限 32 MiB，畸形 JSON 可恢复；RPC 请求通过 ID 关联 pending 响应，不依赖响应顺序。后台持续读流，16ms 合批推送界面，每个会话事件序号在运行时重建后继续递增。

运行中的 prompt 返回仅代表接受，`agent_settled` 才释放调度槽。最多四个任务同时执行，后续 prompt 入队；steer / follow_up 与全局调度队列区别处理。压缩与重试沿用 pi 状态事件。前端依据 Pi 1.1 的 assistantMessageEvent 增量构造实时内容，最终 message_end 覆盖增量快照。工具结果展开时截断展示，历史按需增加渲染数量。

停止 / 切换模式清理旧进程并恢复同一个会话文件。旧进程迟到的事件不会污染新运行时。相同环境与规范化会话文件禁止重复打开。退出不会重放请求；崩溃后保留中断标记。

## 进程所有权

Windows Job Object 设置 KILL_ON_JOB_CLOSE，拥有 helper、pi、WSL 启动器和终端进程，主程序异常退出也清理 Windows 子进程树。WSL 使用 `setsid --wait` 建立独立进程组，通过私有 pid 文件、环境标记和 SQLite 注册表校验所属进程，启动恢复时清理遗留进程组。仅向确认拥有的组发送 TERM / KILL，不调用发行版 shutdown。

Helper 源码通过 stdin 传递给 WSL Node，引导器消费首行后恢复 JSONL 请求流，规避 Windows argv 长度限制。路径参数以 argv 传入，shell 文本仅用于固定启动器及明确转义的应用路径。Windows PTY 使用 ConPTY；xterm 接收事件并回应初始光标位置查询，终端关闭先释放输入及 owned child 再释放 PTY。

## 工具与文件边界

前端只能调用已登记 IPC / helper action；未提供任意命令执行 API。文件读取与保存限制在工作目录，拒绝路径穿越、符号链接逃逸、认证资源读取和过大文本文件。用户主动开启的交互终端以及受信任执行模式按当前用户权限运行。

规划进程强制 `--no-extensions --no-mcp --tools read,grep,find,ls`，后台拒绝 shell RPC、slash / bang 命令及命令生成的认证配置；重建时重新施加限制。规划是限制智能体可用工具，不是对用户本人操作终端的权限沙箱。

## Git 与 UI

新任务创建 codex/ 分支及 HEAD worktree，原目录脏改动不复制。会话导入与分支默认保留 cwd。Git helper 提供状态、工作区 / 暂存 Diff、暂存、提交、分支、cherry-pick、冲突继续 / 中止。worktree 删除检查运行 / 终端占用、修改及提交可达性和 cherry 等价关系。

工作区按访问过的会话保持组件挂载；标签切换保留编辑器和终端。Monaco 语言 worker 本地打包，主题通过 editor tokens 更改，xterm 动态更新颜色。缩放以逻辑窗口宽度决定密度；窄布局隐藏对话的交互区域，工作区独占剩余空间。

`src/theme` 复制自用户已有 WSL Manager，业务适配在 App / Workspace / app.css。背景、壁纸、遮罩、表面与正文分层，低性能关闭 blur，支持 forced-colors、减少透明效果及键盘焦点。

## 兼容性

基线为 pi 1.1.0 / Node ≥22.19。检测包版本、SDK SessionManager / ModelRuntime、RPC 和只读 CLI 开关；不自动更新用户安装。MCP 复用该版本 pi 内部模块，后续 pi 变更需再验证。扩展 select / confirm / input / editor 映射桌面控件，终端特定接口明确提示受限。
