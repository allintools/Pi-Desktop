import { useEffect, useRef, useState, lazy, Suspense } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Plus,
  Search,
  Settings as SettingsIcon,
  PanelRight,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  Square,
  ImagePlus,
  FolderOpen,
  TerminalSquare,
  GitBranch,
  Pin,
  Archive,
  RefreshCw,
  Copy,
  Check,
  Leaf,
  X,
  Paperclip,
  Ellipsis,
  ShieldCheck,
  CornerDownRight,
  Clock,
  Blocks,
  Unplug,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, call, native } from "./api";
import type {
  Project,
  Session,
  PiMessage,
  DesktopEvent,
  Target,
} from "./types";
const Workspace = lazy(() => import("./Workspace"));
import Settings from "./Settings";
import { rememberedTarget } from "./RuntimeSetup";
import { applyStream } from "./stream";
type Transcript = {
  messages: PiMessage[];
  entries: any[];
  models: any[];
  state: any;
  stats: any;
  status: string;
  dialogs: any[];
  notices: string[];
  tools: Record<string, any>;
};
const blank = (): Transcript => ({
  messages: [],
  entries: [],
  models: [],
  state: {},
  stats: {},
  status: "idle",
  dialogs: [],
  notices: [],
  tools: {},
});
const contentText = (content: any) =>
  typeof content === "string"
    ? content
    : (content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
const readLocal = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const uid = () => crypto.randomUUID();
function Message({ message }: { message: PiMessage }) {
  if (
    message.role === "system" ||
    (!message.errorMessage &&
      (!message.content ||
        (Array.isArray(message.content) && message.content.length === 0)))
  )
    return null;
  if (message.role === "toolResult")
    return (
      <details className={"tool-result " + (message.isError ? "failed" : "")}>
        <summary>
          <TerminalSquare size={14} />
          {message.toolName || "工具结果"}
          {message.isError ? " · 失败" : ""}
        </summary>
        <pre>{contentText(message.content).slice(0, 100000)}</pre>
      </details>
    );
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content || [];
  return (
    <article
      className={"message " + (message.role === "user" ? "user" : "assistant")}
    >
      <div className="message-label">
        {message.role === "user" ? "你" : "pi"}
        <button
          aria-label="复制消息"
          onClick={() =>
            void navigator.clipboard.writeText(contentText(message.content))
          }
        >
          <Copy size={13} />
        </button>
      </div>
      <div className="message-content">
        {blocks.map((b: any, i: number) =>
          b.type === "text" ? (
            <ReactMarkdown
              key={i}
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      if (href) void call("open_url", { url: href });
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {b.text}
            </ReactMarkdown>
          ) : b.type === "thinking" ? (
            <details key={i} className="thinking">
              <summary>思考过程</summary>
              <pre>{b.thinking}</pre>
            </details>
          ) : b.type === "toolCall" ? (
            <details key={i} className="tool-call">
              <summary>
                <TerminalSquare size={14} />
                {b.name}
              </summary>
              <pre>
                {b.argumentText || JSON.stringify(b.arguments, null, 2)}
              </pre>
            </details>
          ) : b.type === "image" ? (
            <img
              key={i}
              className="message-image"
              src={"data:" + b.mimeType + ";base64," + b.data}
              alt="对话图片"
            />
          ) : null,
        )}
        {message.errorMessage && (
          <p className="notice error">{message.errorMessage}</p>
        )}
      </div>
    </article>
  );
}
function Dialog({
  request,
  onRespond,
}: {
  request: any;
  onRespond: (v: any) => void;
}) {
  const [value, setValue] = useState(request.prefill || "");
  useEffect(() => {
    if (!request.timeout) return;
    const timer = setTimeout(
      () => onRespond({ cancelled: true }),
      request.timeout,
    );
    return () => clearTimeout(timer);
  }, [request.id]);
  return (
    <div className="dialog-backdrop">
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-title"
      >
        <h2 id="extension-title">{request.title || "扩展请求"}</h2>
        {request.message && <p>{request.message}</p>}
        {request.method === "select" ? (
          <div className="dialog-options">
            {request.options.map((o: string) => (
              <button key={o} onClick={() => onRespond({ value: o })}>
                {o}
              </button>
            ))}
          </div>
        ) : request.method === "confirm" ? (
          <div className="row">
            <button
              className="primary"
              onClick={() => onRespond({ confirmed: true })}
            >
              确认
            </button>
            <button onClick={() => onRespond({ confirmed: false })}>
              拒绝
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onRespond({ value });
            }}
          >
            {request.method === "editor" ? (
              <textarea
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            ) : (
              <input
                autoFocus
                value={value}
                placeholder={request.placeholder}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <button className="primary">提交</button>
          </form>
        )}
        <button
          className="dialog-cancel"
          onClick={() => onRespond({ cancelled: true })}
        >
          取消
        </button>
      </section>
    </div>
  );
}
export default function App() {
  const [layoutReady, setLayoutReady] = useState(!native);
  const [settingsTab, setSettingsTab] = useState("appearance");
  const [projects, setProjects] = useState<Project[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [active, setActive] = useState(""),
    [projectId, setProjectId] = useState(""),
    [page, setPage] = useState("chat"),
    [collapsed, setCollapsed] = useState(
      () => readLocal("pi-desktop.sidebar") === "collapsed",
    ),
    [search, setSearch] = useState(""),
    [showArchived, setShowArchived] = useState(false),
    [panel, setPanel] = useState(true),
    [panelWidth, setPanelWidth] = useState(
      () => Number(readLocal("pi-desktop.panelWidth")) || 420,
    ),
    [draft, setDraft] = useState(""),
    [images, setImages] = useState<any[]>([]),
    [transcripts, setTranscripts] = useState<Record<string, Transcript>>({}),
    [notice, setNotice] = useState(""),
    [projectDialog, setProjectDialog] = useState(false),
    [newDialog, setNewDialog] = useState(false),
    [history, setHistory] = useState<any[] | null>(null),
    [busy, setBusy] = useState(false),
    [visibleCount, setVisibleCount] = useState(80),
    [queueBehavior, setQueueBehavior] = useState("steer");
  const [name, setName] = useState(""),
    [path, setPath] = useState(""),
    [target, setTarget] = useState<Target>(() =>
      rememberedTarget({ kind: "windows" }),
    ),
    [distros, setDistros] = useState<string[]>([]),
    [taskName, setTaskName] = useState(""),
    [isolated, setIsolated] = useState(true),
    [mode, setMode] = useState("plan");
  useEffect(() => {
    if (!native || !layoutReady) return;
    const timer = setTimeout(() => {
      void call("layout_save", {
        value: { collapsed, panel, width: panelWidth },
      }).catch((e) => report(String(e)));
    }, 150);
    return () => clearTimeout(timer);
  }, [layoutReady, collapsed, panel, panelWidth]);
  const scroll = useRef<HTMLDivElement>(null),
    imageInput = useRef<HTMLInputElement>(null),
    lastSequence = useRef(new Map<string, number>()),
    activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (projectDialog)
      setTarget((t) =>
        rememberedTarget({ kind: t.kind, distro: t.distro, user: t.user }),
      );
  }, [projectDialog]);
  const selected = sessions.find((s) => s.id === active),
    project = projects.find((p) => p.id === (selected?.projectId || projectId)),
    transcript = transcripts[active] || blank(),
    running = ["running", "queued", "compacting", "retrying"].includes(
      transcript.status,
    );
  const report = (s: string) => setNotice(s);
  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      report(String(e));
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    if (!native) return;
    const data = await api.metadata();
    setProjects(data.projects);
    setSessions(data.sessions);
    if (!layoutReady && data.layout) {
      setCollapsed(data.layout.collapsed);
      setPanel(data.layout.panel);
      setPanelWidth(data.layout.width);
    }
    setLayoutReady(true);
    if (data.projects.length === 0) {
      setSettingsTab("runtime");
      setPage("settings");
    }
    if (!projectId && data.projects.length) setProjectId(data.projects[0].id);
  };
  const update = (id: string, fn: (t: Transcript) => Transcript) =>
    setTranscripts((all) => ({ ...all, [id]: fn(all[id] || blank()) }));
  const replaceSession = (s: Session) =>
    setSessions((list) =>
      list.some((v) => v.id === s.id)
        ? list.map((v) => (v.id === s.id ? s : v))
        : [...list, s],
    );
  useEffect(() => {
    void reload().catch((e) => report(String(e)));
    if (native)
      void call<string[]>("distributions")
        .then(setDistros)
        .catch(() => {});
  }, []);
  useEffect(() => {
    let stop = () => {};
    let disposed = false;
    api
      .subscribe((event: DesktopEvent) => {
        if (event.kind === "job") return;
        const previous = lastSequence.current.get(event.sessionId) ?? -1;
        if (event.sequence <= previous) return;
        lastSequence.current.set(event.sessionId, event.sequence);
        if (event.kind === "exit") {
          lastSequence.current.delete(event.sessionId);
          update(event.sessionId, (t) => ({
            ...t,
            status: t.status === "idle" ? "idle" : "interrupted",
          }));
          return;
        }
        update(event.sessionId, (t) => {
          const p = event.payload;
          let next = { ...t };
          if (event.kind === "queued") next.status = "queued";
          if (event.kind === "queue_cleared") next.status = "idle";
          if (event.kind === "queued_started") next.status = "running";
          if (event.kind === "diagnostic" || event.kind === "protocol_error")
            next.notices = [...t.notices.slice(-7), p.text || p.message];
          if (event.kind !== "pi") return next;
          if (p.type === "agent_start") next.status = "running";
          if (p.type === "agent_settled") next.status = "idle";
          if (["auto_compaction_start", "compaction_start"].includes(p.type))
            next.status = "compacting";
          if (["auto_compaction_end", "compaction_end"].includes(p.type))
            next.status =
              p.reason === "manual" && !p.willRetry ? "idle" : "running";
          if (p.type === "auto_retry_start") next.status = "retrying";
          if (p.type === "auto_retry_end") next.status = "running";
          if (p.type === "message_start")
            next.messages = [...t.messages, p.message];
          if (p.type === "message_update" && p.assistantMessageEvent) {
            const messages = t.messages.slice();
            const index = messages.length - 1;
            if (index >= 0 && messages[index].role === "assistant")
              messages[index] = applyStream(
                messages[index],
                p.assistantMessageEvent,
                p.usage,
              );
            next.messages = messages;
          }
          if (
            p.type === "message_end" ||
            (p.type === "message_update" && p.message)
          ) {
            const messages = t.messages.slice();
            if (
              messages.length &&
              messages[messages.length - 1].role === p.message?.role
            )
              messages[messages.length - 1] = p.message;
            else if (p.message) messages.push(p.message);
            next.messages = messages;
          }
          if (
            p.type === "tool_execution_start" ||
            p.type === "tool_execution_update"
          )
            next.tools = {
              ...t.tools,
              [p.toolCallId]: {
                name: p.toolName,
                text:
                  contentText(p.partialResult?.content) ||
                  JSON.stringify(p.args, null, 2),
              },
            };
          if (p.type === "tool_execution_end") {
            next.tools = { ...t.tools };
            delete next.tools[p.toolCallId];
          }
          if (p.type === "queue_update")
            next.state = {
              ...t.state,
              steering: p.steering,
              followUp: p.followUp,
            };
          if (p.type === "thinking_level_changed")
            next.state = { ...t.state, thinkingLevel: p.level };
          if (p.type === "summarization_retry_scheduled")
            next.status = "retrying";
          if (p.type === "extension_ui_request") {
            if (["select", "confirm", "input", "editor"].includes(p.method))
              next.dialogs = [...t.dialogs, p];
            else if (p.method === "notify")
              next.notices = [...t.notices.slice(-7), p.message];
            else if (
              ["setStatus", "set_status", "setWidget", "set_widget"].includes(
                p.method,
              )
            )
              next.notices = [
                ...t.notices.slice(-7),
                p.text || p.content?.join("\n") || p.key || "扩展状态已更新",
              ];
            else if (
              p.method === "set_editor_text" &&
              event.sessionId === activeRef.current
            )
              setDraft(p.text || "");
          }
          if (p.type === "response" && p.success === false)
            next.notices = [...t.notices.slice(-7), p.error];
          return next;
        });
        if (event.kind === "pi" && event.payload.type === "agent_settled")
          void api
            .rpc(event.sessionId, { type: "get_session_stats" })
            .then((stats) => update(event.sessionId, (t) => ({ ...t, stats })))
            .catch(() => {});
      })
      .then((off) => {
        if (disposed) off();
        else stop = off;
      });
    return () => {
      disposed = true;
      stop();
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setVisibleCount(80);
    const id = selected.id;
    void api
      .request("session.history", {}, { sessionId: id })
      .then((r) => {
        if (!cancelled)
          update(id, (t) => ({
            ...t,
            messages: t.status === "running" ? t.messages : r.messages,
            entries: r.entries,
            status:
              !transcripts[id] &&
              ["running", "queued"].includes(selected.runtimeState || "")
                ? "interrupted"
                : t.status,
          }));
      })
      .catch((e) => report(String(e)));
    return () => {
      cancelled = true;
    };
  }, [active]);
  useEffect(() => {
    const el = scroll.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 300)
      el.scrollTop = el.scrollHeight;
  }, [transcript.messages]);
  const hydrateRuntime = async () => {
    if (!selected) throw new Error("请先创建会话");
    const id = selected.id;
    const r = await call<any>("runtime_open", { id });
    const models = await api.rpc(id, { type: "get_available_models" });
    const levels = await api.rpc(id, { type: "get_available_thinking_levels" });
    r.state.availableThinkingLevels = Array.isArray(levels)
      ? levels
      : levels.levels;
    update(id, (t) => ({
      ...t,
      state: r.state,
      models: Array.isArray(models) ? models : models.models || [],
      status: r.busy
        ? "running"
        : t.status === "interrupted"
          ? "idle"
          : t.status,
    }));
    return id;
  };
  const send = async () => {
    if (!draft.trim() && !images.length) return;
    await run(async () => {
      const sent = draft,
        sentImages = images;
      const id = await hydrateRuntime();
      const response = await api.rpc(id, {
        type: running
          ? queueBehavior === "followUp"
            ? "follow_up"
            : "steer"
          : "prompt",
        message: sent,
        images: sentImages,
      });
      if (activeRef.current === id) {
        setDraft((value) => (value === sent ? "" : value));
        setImages((value) => (value === sentImages ? [] : value));
      } else if (drafts.current.get(id)?.text === sent)
        drafts.current.delete(id);
      if (!running)
        update(id, (t) => ({
          ...t,
          status:
            response?.disposition === "queued"
              ? "queued"
              : response?.disposition === "handled"
                ? "idle"
                : t.status === "idle"
                  ? "idle"
                  : t.status,
        }));
      if (selected) replaceSession(await api.updateSession(id, {}));
    });
  };
  const drafts = useRef(new Map<string, { text: string; images: any[] }>());
  const changeSession = (s: Session) => {
    drafts.current.set(active, { text: draft, images });
    const saved = drafts.current.get(s.id);
    setActive(s.id);
    setProjectId(s.projectId);
    setPage("chat");
    setDraft(saved?.text || "");
    setImages(saved?.images || []);
  };
  useEffect(() => {
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement;
    const backgrounds = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".app-shell>.sidebar,.app-shell>.main",
      ),
    );
    backgrounds.forEach((el) => (el.inert = true));
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ),
      ).filter((el) => el.getClientRects().length);
    focusable()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (projectDialog) setProjectDialog(false);
        else if (newDialog) setNewDialog(false);
        else if (history) setHistory(null);
        else if (transcript.dialogs[0]) {
          const req = transcript.dialogs[0];
          void api
            .rpc(active, {
              type: "extension_ui_response",
              id: req.id,
              cancelled: true,
            })
            .then(() =>
              update(active, (t) => ({
                ...t,
                dialogs: t.dialogs.filter((d) => d.id !== req.id),
              })),
            );
        }
      }
      if (e.key === "Tab") {
        const nodes = focusable(),
          first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      backgrounds.forEach((el) => (el.inert = false));
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [projectDialog, newDialog, history, transcript.dialogs[0]?.id]);
  const toggleSidebar = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(
          "pi-desktop.sidebar",
          !c ? "collapsed" : "expanded",
        );
      } catch {
        report("侧栏偏好未保存");
      }
      return !c;
    });
  const addProject = async () =>
    run(async () => {
      if (!path.trim()) throw new Error("请输入项目路径");
      const p = await api.saveProject({
        id: "",
        name: name || path.split(/[\\/]/).filter(Boolean).pop() || "项目",
        path,
        target,
        trusted: true,
      });
      setProjects((v) => [...v, p]);
      setProjectId(p.id);
      setActive("");
      setProjectDialog(false);
      report("项目已添加。此项目在执行模式下使用当前用户权限。");
    });
  const createTask = async () =>
    run(async () => {
      if (!project) throw new Error("请先添加项目");
      const s = await api.newSession(
        project.id,
        taskName.trim() || "新任务",
        isolated,
        mode,
      );
      replaceSession(s);
      changeSession(s);
      setNewDialog(false);
      setTaskName("");
    });
  const importHistory = async () =>
    run(async () => {
      if (!project) return;
      setHistory(
        await api.request("session.list", {}, { projectId: project.id }),
      );
    });
  const attach = async (files: FileList | null) => {
    if (!files) return;
    await run(async () => {
      const added: any[] = [];
      for (const f of Array.from(files)) {
        if (
          !/^image\/(png|jpeg|webp)$/.test(f.type) ||
          f.size > 20 * 1024 * 1024
        )
          throw new Error("请选择 20 MB 以内的 PNG、JPEG 或 WebP");
        const bitmap = await createImageBitmap(f);
        try {
          const ratio = Math.min(
            1,
            1920 / Math.max(bitmap.width, bitmap.height),
          );
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(bitmap.width * ratio);
          canvas.height = Math.round(bitmap.height * ratio);
          canvas
            .getContext("2d")!
            .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
          if (data.length > 3 * 1024 * 1024) throw new Error("压缩后图片过大");
          added.push({
            type: "image",
            mimeType: "image/jpeg",
            data,
            name: f.name,
          });
        } finally {
          bitmap.close();
        }
      }
      setImages((v) => [...v, ...added].slice(0, 5));
    });
    if (imageInput.current) imageInput.current.value = "";
  };
  const forkTask = async (entryId?: string) =>
    run(async () => {
      if (!selected || !project) return;
      const independent = window.confirm(
        "为分支会话创建独立 worktree？\n确定：独立工作区；取消：沿用当前目录。",
      );
      const s = await api.newSession(
        project.id,
        selected.name + " · 分支",
        independent,
        selected.mode,
        { fork: selected.id, entryId: entryId || null },
      );
      replaceSession(s);
      changeSession(s);
    });
  const title =
    page === "settings"
      ? "设置"
      : selected?.name || project?.name || "开始你的下一个项目";
  return (
    <div
      className={"app-shell " + (collapsed ? "sidebar-collapsed" : "")}
      style={{ "--workspace-width": panelWidth + "px" } as React.CSSProperties}
    >
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.png" alt="" />
          <strong>Pi Desktop</strong>
          <span>LOCAL</span>
        </div>
        <button
          aria-label="新建任务"
          className="new-task primary"
          disabled={!native}
          onClick={() =>
            project ? setNewDialog(true) : setProjectDialog(true)
          }
        >
          <Plus size={17} />
          <span>新建任务</span>
        </button>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="搜索项目和会话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索项目与会话"
          />
        </label>
        <div className="project-list">
          <div className="sidebar-section">
            <span>项目</span>
            <button
              title="添加项目"
              aria-label="添加项目"
              disabled={!native}
              onClick={() => setProjectDialog(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          {projects
            .filter(
              (p) =>
                p.name.toLowerCase().includes(search.toLowerCase()) ||
                sessions.some(
                  (s) =>
                    s.projectId === p.id &&
                    s.name.toLowerCase().includes(search.toLowerCase()),
                ),
            )
            .map((p) => (
              <section key={p.id} className="project-group">
                <button
                  aria-label={"项目 " + p.name}
                  className={
                    "project-name " + (project?.id === p.id ? "selected" : "")
                  }
                  onClick={() => {
                    setProjectId(p.id);
                    setActive("");
                    setPage("chat");
                  }}
                >
                  <FolderOpen size={16} />
                  <span>{p.name}</span>
                  <small>{p.target.kind === "wsl" ? "WSL" : "WIN"}</small>
                </button>
                {sessions
                  .filter(
                    (s) =>
                      s.projectId === p.id &&
                      s.archived === showArchived &&
                      s.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .sort(
                    (a, b) =>
                      Number(b.pinned) - Number(a.pinned) ||
                      b.updated - a.updated,
                  )
                  .map((s) => (
                    <div
                      key={s.id}
                      className={
                        "session-row " +
                        (active === s.id && page === "chat" ? "active" : "")
                      }
                    >
                      <button
                        className="session-select"
                        onClick={() => changeSession(s)}
                      >
                        {s.pinned ? (
                          <Pin size={12} />
                        ) : (
                          <span
                            className={
                              "status-dot " +
                              (transcripts[s.id]?.status || "idle")
                            }
                          />
                        )}
                        <span>{s.name}</span>
                      </button>
                      <details className="session-menu">
                        <summary aria-label={"管理 " + s.name}>
                          <Ellipsis size={15} />
                        </summary>
                        <div>
                          <button
                            onClick={() =>
                              void run(async () =>
                                replaceSession(
                                  await api.updateSession(s.id, {
                                    pinned: !s.pinned,
                                  }),
                                ),
                              )
                            }
                          >
                            <Pin size={13} />
                            {s.pinned ? "取消置顶" : "置顶"}
                          </button>
                          <button
                            onClick={() =>
                              void run(async () => {
                                const value = window.prompt("会话名称", s.name);
                                if (value) {
                                  await api.request(
                                    "session.rename",
                                    { name: value },
                                    { sessionId: s.id },
                                  );
                                  replaceSession(
                                    await api.updateSession(s.id, {
                                      name: value,
                                    }),
                                  );
                                }
                              })
                            }
                          >
                            重命名
                          </button>
                          <button
                            onClick={() =>
                              void run(async () =>
                                replaceSession(
                                  await api.updateSession(s.id, {
                                    archived: !s.archived,
                                  }),
                                ),
                              )
                            }
                          >
                            <Archive size={13} />
                            {s.archived ? "恢复" : "归档"}
                          </button>
                          <button
                            onClick={() =>
                              void run(async () => {
                                await call("runtime_close", { id: s.id });
                                update(s.id, (t) => ({ ...t, status: "idle" }));
                              })
                            }
                          >
                            <Unplug size={13} />
                            断开运行时
                          </button>
                        </div>
                      </details>
                    </div>
                  ))}
              </section>
            ))}
          {projects.length === 0 && (
            <p className="sidebar-empty">
              添加本地或 WSL 项目
              <br />
              继续你已有的 pi 会话
            </p>
          )}
        </div>
        <footer className="sidebar-footer">
          <button
            aria-label={showArchived ? "查看活动会话" : "已归档"}
            className={showArchived ? "active" : ""}
            onClick={() => setShowArchived((v) => !v)}
          >
            <Archive size={15} />
            <span>{showArchived ? "查看活动会话" : "已归档"}</span>
          </button>
          <button
            aria-label="技能与配置"
            onClick={() => {
              setSettingsTab("resources");
              setPage("settings");
              setPanel(false);
            }}
          >
            <Blocks size={15} />
            <span>技能与配置</span>
          </button>
          <button
            aria-label="设置与外观"
            className={page === "settings" ? "active" : ""}
            onClick={() => {
              setSettingsTab("appearance");
              setPage("settings");
            }}
          >
            <SettingsIcon size={15} />
            <span>设置与外观</span>
          </button>
          <div className="environment-foot">
            <span className="status-dot idle" />
            <span>{native ? "本地桌面 · 1.0.1" : "浏览器视觉预览"}</span>
          </div>
        </footer>
        <button
          className="sidebar-toggle"
          title={collapsed ? "展开侧栏" : "折叠侧栏"}
          aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
          onClick={toggleSidebar}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>{project?.name || "Pi Desktop"}</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-context">
            {project && (
              <span className="environment-badge">
                {project.target.kind === "wsl"
                  ? project.target.distro
                  : "Windows"}
              </span>
            )}
            {selected?.branch && (
              <span className="branch-badge">
                <GitBranch size={13} />
                {selected.branch}
              </span>
            )}
            {selected && (
              <button
                aria-label="切换工作区面板"
                title="文件、Diff 与终端"
                className={panel ? "active" : ""}
                onClick={() => setPanel((v) => !v)}
              >
                <PanelRight size={17} />
              </button>
            )}
          </div>
        </header>
        {notice && (
          <div className="global-notice" role="status">
            <span>{notice}</span>
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              <X size={14} />
            </button>
          </div>
        )}
        {page === "settings" ? (
          <Settings
            project={project}
            initialTab={settingsTab}
            report={report}
            onProject={(p) =>
              setProjects((v) => v.map((q) => (q.id === p.id ? p : q)))
            }
          />
        ) : (
          <div
            className={
              "workbench " + (panel && selected ? "with-workspace" : "")
            }
          >
            <section className="conversation">
              {selected ? (
                <>
                  <div className="conversation-toolbar">
                    <div>
                      <span className={"status-dot " + transcript.status} />
                      <span>
                        {
                          (
                            {
                              idle: "就绪",
                              running: "正在执行",
                              queued: "排队中",
                              retrying: "正在重试",
                              compacting: "压缩上下文",
                              interrupted: "运行中断，可继续",
                            } as Record<string, string>
                          )[transcript.status]
                        }
                      </span>
                      <code title={selected.cwd}>{selected.cwd}</code>
                    </div>
                    <div>
                      <button
                        disabled={busy || running}
                        title="重新连接并载入模型"
                        onClick={() => void run(hydrateRuntime)}
                      >
                        <RefreshCw size={14} />
                      </button>
                      <button
                        disabled={busy || running}
                        title="分支会话"
                        onClick={() => void forkTask()}
                      >
                        <GitBranch size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="messages" ref={scroll}>
                    {transcript.messages.length > visibleCount && (
                      <button
                        className="load-earlier"
                        onClick={() => setVisibleCount((n) => n + 80)}
                      >
                        显示更早的消息
                      </button>
                    )}
                    {transcript.messages.slice(-visibleCount).map((m, i) => (
                      <Message
                        key={
                          i +
                          Math.max(0, transcript.messages.length - visibleCount)
                        }
                        message={m}
                      />
                    ))}
                    {transcript.messages.length === 0 && (
                      <div className="conversation-empty">
                        <Leaf size={34} />
                        <h2>
                          {selected.mode === "plan"
                            ? "先把想法变成计划"
                            : "让 pi 开始工作"}
                        </h2>
                        <p>
                          {selected.mode === "plan"
                            ? "描述目标。pi 可以阅读和搜索项目，给出实现方案。"
                            : "描述要实现的功能，pi 将在此工作区执行。"}
                        </p>
                        <span className="workspace-label">
                          <GitBranch size={13} />
                          {selected.worktree ? "独立 worktree" : "当前项目目录"}
                        </span>
                      </div>
                    )}
                    {Object.entries(transcript.tools).map(([id, tool]) => (
                      <details open className="tool-call" key={id}>
                        <summary>
                          <TerminalSquare size={14} />
                          {tool.name} · 运行中
                        </summary>
                        <pre>{tool.text?.slice(-64000)}</pre>
                      </details>
                    ))}
                    {transcript.notices.length > 0 && (
                      <details className="diagnostics">
                        <summary>
                          运行提示 ({transcript.notices.length})
                        </summary>
                        {transcript.notices.map((s, i) => (
                          <pre key={i}>{s}</pre>
                        ))}
                      </details>
                    )}
                  </div>
                  <div className="composer-wrap">
                    {images.length > 0 && (
                      <div className="attachments">
                        {images.map((im, i) => (
                          <div key={i}>
                            <img
                              src={"data:" + im.mimeType + ";base64," + im.data}
                              alt={im.name}
                            />
                            <button
                              aria-label="移除图片"
                              onClick={() =>
                                setImages((v) => v.filter((_, k) => k !== i))
                              }
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="composer">
                      <textarea
                        aria-label="消息输入"
                        placeholder={
                          selected.mode === "plan"
                            ? "描述你的目标，先规划实现方案…"
                            : "描述任务，或添加后续指令…"
                        }
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                      />
                      <div className="composer-tools">
                        <div className="composer-options">
                          <button
                            title="添加图片"
                            aria-label="添加图片"
                            disabled={busy}
                            onClick={() => imageInput.current?.click()}
                          >
                            <ImagePlus size={16} />
                          </button>
                          <input
                            hidden
                            ref={imageInput}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            multiple
                            onChange={(e) => void attach(e.target.files)}
                          />
                          <button
                            title="引用工作区文件"
                            aria-label="引用工作区文件"
                            onClick={() =>
                              void run(async () => {
                                const p =
                                  window.prompt("工作区内的文件相对路径");
                                if (p) {
                                  const r = await api.request(
                                    "file.read",
                                    { path: p },
                                    { sessionId: selected.id },
                                  );
                                  setDraft(
                                    (d) =>
                                      d +
                                      "\n\n文件 " +
                                      p +
                                      "\n```\n" +
                                      r.text.slice(0, 64000) +
                                      "\n```",
                                  );
                                }
                              })
                            }
                          >
                            <Paperclip size={16} />
                          </button>
                          <select
                            aria-label="规划或执行模式"
                            disabled={busy || running}
                            value={selected.mode}
                            onChange={(e) =>
                              void run(async () => {
                                replaceSession(
                                  await api.updateSession(selected.id, {
                                    mode: e.target.value as Session["mode"],
                                  }),
                                );
                                update(selected.id, (t) => ({
                                  ...t,
                                  state: {},
                                  models: [],
                                  status: "idle",
                                }));
                                lastSequence.current.delete(selected.id);
                              })
                            }
                          >
                            <option value="plan">规划 · 只读</option>
                            <option value="execute">执行 · 自主</option>
                          </select>
                          <select
                            aria-label="模型"
                            value={
                              transcript.state.model
                                ? transcript.state.model.provider +
                                  "/" +
                                  transcript.state.model.id
                                : ""
                            }
                            onFocus={() => {
                              if (!transcript.models.length)
                                void run(hydrateRuntime);
                            }}
                            onChange={(e) =>
                              void run(async () => {
                                const [provider, ...id] =
                                  e.target.value.split("/");
                                await api.rpc(selected.id, {
                                  type: "set_model",
                                  provider,
                                  modelId: id.join("/"),
                                });
                                const state = await api.rpc(selected.id, {
                                  type: "get_state",
                                });
                                update(selected.id, (t) => ({
                                  ...t,
                                  state: { ...t.state, ...state },
                                }));
                              })
                            }
                          >
                            <option value="">选择模型</option>
                            {transcript.models.map((m) => (
                              <option
                                key={m.provider + "/" + m.id}
                                value={m.provider + "/" + m.id}
                              >
                                {m.name || m.id}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="思考等级"
                            value={transcript.state.thinkingLevel || "medium"}
                            onChange={(e) =>
                              void run(async () => {
                                await hydrateRuntime();
                                await api.rpc(selected.id, {
                                  type: "set_thinking_level",
                                  level: e.target.value,
                                });
                                const state = await api.rpc(selected.id, {
                                  type: "get_state",
                                });
                                update(selected.id, (t) => ({
                                  ...t,
                                  state: { ...t.state, ...state },
                                }));
                              })
                            }
                          >
                            {(
                              transcript.state.availableThinkingLevels || [
                                "off",
                                "minimal",
                                "low",
                                "medium",
                                "high",
                                "xhigh",
                              ]
                            ).map((level: string) => (
                              <option key={level}>{level}</option>
                            ))}
                          </select>
                        </div>
                        <div className="send-tools">
                          {running && (
                            <>
                              <select
                                aria-label="运行中消息策略"
                                value={queueBehavior}
                                onChange={(e) =>
                                  setQueueBehavior(e.target.value)
                                }
                              >
                                <option value="steer">追加指令</option>
                                <option value="followUp">完成后执行</option>
                              </select>
                              <button
                                className="stop"
                                aria-label="停止任务"
                                onClick={() =>
                                  void run(async () => {
                                    await api.rpc(selected.id, {
                                      type: "abort",
                                    });
                                    update(selected.id, (t) => ({
                                      ...t,
                                      status: "idle",
                                    }));
                                  })
                                }
                              >
                                <Square size={15} />
                              </button>
                            </>
                          )}
                          <button
                            className="send primary"
                            aria-label="发送消息"
                            disabled={busy || (!draft.trim() && !images.length)}
                            onClick={() => void send()}
                          >
                            <ArrowUp size={18} />
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="composer-footer">
                      <span>
                        {selected.mode === "plan" ? (
                          <>
                            <ShieldCheck size={12} />
                            规划工具仅限读取与搜索
                          </>
                        ) : (
                          <>
                            <ShieldCheck size={12} />
                            此项目已信任 · 当前用户权限
                          </>
                        )}
                      </span>
                      <div>
                        {transcript.stats?.contextUsage && (
                          <span>
                            上下文{" "}
                            {Math.round(
                              transcript.stats.contextUsage.percent || 0,
                            )}
                            %
                          </span>
                        )}
                        <details>
                          <summary aria-label="上下文与队列控制">
                            <Ellipsis size={14} />
                          </summary>
                          <div>
                            <button
                              disabled={running}
                              onClick={() =>
                                void run(async () => {
                                  await hydrateRuntime();
                                  await api.rpc(selected.id, {
                                    type: "compact",
                                  });
                                })
                              }
                            >
                              压缩上下文
                            </button>
                            <button
                              onClick={() =>
                                void run(async () => {
                                  const r = await api.rpc(selected.id, {
                                    type: "clear_queue",
                                  });
                                  report(
                                    "已移除等待中的指令：" + JSON.stringify(r),
                                  );
                                })
                              }
                            >
                              清空消息队列
                            </button>
                            <button
                              onClick={() =>
                                void run(async () => {
                                  const r = await api.rpc(selected.id, {
                                    type: "get_session_stats",
                                  });
                                  update(selected.id, (t) => ({
                                    ...t,
                                    stats: r,
                                  }));
                                  report(JSON.stringify(r));
                                })
                              }
                            >
                              会话用量
                            </button>
                            <button
                              onClick={() =>
                                void run(async () => {
                                  await api.rpc(selected.id, {
                                    type: "set_auto_compaction",
                                    enabled: !(
                                      transcript.state.autoCompactionEnabled ??
                                      true
                                    ),
                                  });
                                  const state = await api.rpc(selected.id, {
                                    type: "get_state",
                                  });
                                  update(selected.id, (t) => ({
                                    ...t,
                                    state: { ...t.state, ...state },
                                  }));
                                  report(
                                    state.autoCompactionEnabled
                                      ? "自动压缩已开启"
                                      : "自动压缩已关闭",
                                  );
                                })
                              }
                            >
                              切换自动压缩
                            </button>
                            <button
                              onClick={() =>
                                void run(async () => {
                                  await api.rpc(selected.id, {
                                    type: "set_auto_retry",
                                    enabled: !(
                                      transcript.state.autoRetryEnabled ?? true
                                    ),
                                  });
                                  update(selected.id, (t) => ({
                                    ...t,
                                    state: {
                                      ...t.state,
                                      autoRetryEnabled: !(
                                        t.state.autoRetryEnabled ?? true
                                      ),
                                    },
                                  }));
                                })
                              }
                            >
                              切换自动重试
                            </button>
                            <button
                              onClick={() =>
                                void run(async () => {
                                  const rows = await api.rpc(selected.id, {
                                    type: "get_fork_messages",
                                  });
                                  update(selected.id, (t) => ({
                                    ...t,
                                    entries: rows.messages || rows,
                                  }));
                                  report("已载入可分支的历史消息");
                                })
                              }
                            >
                              历史分支
                            </button>
                          </div>
                        </details>
                      </div>
                    </div>
                    {transcript.entries.length > 0 && (
                      <details className="history-branches">
                        <summary>从历史消息创建分支</summary>
                        {transcript.entries.map((entry: any) => (
                          <button
                            key={entry.id}
                            disabled={running}
                            onClick={() => void forkTask(entry.id)}
                          >
                            <GitBranch size={12} />
                            {entry.text?.slice(0, 80) || entry.id}
                          </button>
                        ))}
                      </details>
                    )}
                  </div>
                </>
              ) : (
                <div className="welcome">
                  <div className="welcome-mark">
                    <img src="/icon.png" alt="Pi" />
                  </div>
                  <h1>
                    {project ? "从这里开始工作" : "一个安静的编码工作空间"}
                  </h1>
                  <p>
                    {project
                      ? "选择已有会话，或为新的任务创建独立工作区。"
                      : "连接你已有的 pi，在 Windows 与 WSL 项目中规划、执行和审查代码。"}
                  </p>
                  <div className="welcome-actions">
                    <button
                      className="primary"
                      disabled={!native}
                      onClick={() =>
                        project ? setNewDialog(true) : setProjectDialog(true)
                      }
                    >
                      {project ? <Plus size={16} /> : <FolderOpen size={16} />}{" "}
                      {project ? "创建新任务" : "添加项目"}
                    </button>
                    {project && (
                      <button onClick={() => void importHistory()}>
                        <Clock size={16} />
                        继续 CLI 会话
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setSettingsTab("appearance");
                        setPage("settings");
                      }}
                    >
                      <SettingsIcon size={16} />
                      外观与设置
                    </button>
                  </div>
                  <div className="welcome-path">
                    {project ? (
                      <>
                        <span className="status-dot idle" />
                        <code>{project.path}</code>
                      </>
                    ) : (
                      <>
                        <span>Windows / WSL</span>
                        <span>独立 worktree</span>
                        <span>本地会话</span>
                      </>
                    )}
                  </div>
                  {!native && (
                    <p className="preview-notice">
                      浏览器仅展示界面与主题。项目操作请运行 Pi Desktop
                      桌面程序。
                    </p>
                  )}
                </div>
              )}
            </section>
            {panel && selected && project && (
              <>
                <div
                  className="panel-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整工作区宽度"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                      e.preventDefault();
                      setPanelWidth((w) =>
                        Math.max(
                          300,
                          Math.min(720, w + (e.key === "ArrowLeft" ? 20 : -20)),
                        ),
                      );
                    }
                  }}
                  onPointerDown={(e) => {
                    const start = e.clientX,
                      scale =
                        Number(
                          getComputedStyle(
                            document.documentElement,
                          ).getPropertyValue("--theme-scale"),
                        ) || 1,
                      width =
                        document
                          .querySelector(".workspace-slot")!
                          .getBoundingClientRect().width / scale,
                      maximum =
                        document.documentElement.dataset.density === "compact"
                          ? 350
                          : 720;
                    const move = (ev: PointerEvent) => {
                      const next = Math.max(
                        300,
                        Math.min(maximum, width + (start - ev.clientX) / scale),
                      );
                      setPanelWidth(next);
                      try {
                        localStorage.setItem(
                          "pi-desktop.panelWidth",
                          String(next),
                        );
                      } catch {
                        report("面板宽度未保存");
                      }
                    };
                    const up = () => {
                      document.removeEventListener("pointermove", move);
                      document.removeEventListener("pointerup", up);
                    };
                    document.addEventListener("pointermove", move);
                    document.addEventListener("pointerup", up);
                  }}
                />
                <div className="workspace-slot" />
              </>
            )}
          </div>
        )}
        <div
          className="persistent-workspace"
          hidden={page !== "chat" || !panel || !selected}
          style={{ top: notice ? 89 : 54 }}
        >
          <button className="workspace-return" onClick={() => setPanel(false)}>
            <ChevronLeft size={15} />
            返回对话
          </button>
          <Suspense fallback={<div className="quiet-empty">载入工作区…</div>}>
            {sessions
              .filter((s) => s.id === active || transcripts[s.id])
              .map((s) => (
                <div
                  key={s.id}
                  hidden={s.id !== active}
                  className="workspace-container"
                >
                  <Workspace
                    session={s}
                    project={projects.find((p) => p.id === s.projectId)!}
                    report={report}
                  />
                </div>
              ))}
          </Suspense>
        </div>
      </main>
      {projectDialog && (
        <div className="dialog-backdrop">
          <form
            className="dialog project-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={projectDialog ? "添加项目" : "新建任务"}
            onSubmit={(e) => {
              e.preventDefault();
              void addProject();
            }}
          >
            <h2>添加项目</h2>
            <p className="muted">
              绑定项目目录和执行环境。执行模式下 pi 使用当前用户权限。
            </p>
            <label className="field">
              项目名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="可留空"
              />
            </label>
            <label className="field">
              执行环境
              <select
                value={target.kind}
                onChange={(e) =>
                  setTarget(
                    rememberedTarget({
                      kind: e.target.value as Target["kind"],
                      distro: e.target.value === "wsl" ? distros[0] : undefined,
                    }),
                  )
                }
              >
                <option value="windows">Windows 本地</option>
                <option value="wsl">WSL</option>
              </select>
            </label>
            {target.kind === "wsl" && (
              <>
                <label className="field">
                  发行版
                  <select
                    value={target.distro || ""}
                    onChange={(e) =>
                      setTarget(
                        rememberedTarget({
                          kind: "wsl",
                          distro: e.target.value,
                        }),
                      )
                    }
                  >
                    {distros.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Linux 用户
                  <input
                    value={target.user || ""}
                    onChange={(e) =>
                      setTarget(
                        rememberedTarget({
                          kind: "wsl",
                          distro: target.distro,
                          user: e.target.value || undefined,
                        }),
                      )
                    }
                    placeholder="留空使用发行版默认用户"
                  />
                </label>
              </>
            )}
            <label className="field">
              项目路径
              <div className="row">
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  required
                  placeholder={
                    target.kind === "wsl"
                      ? "/home/user/project"
                      : "C:\\Projects\\my-app"
                  }
                />
                {target.kind === "windows" && (
                  <button
                    type="button"
                    onClick={() =>
                      void open({ directory: true, multiple: false }).then(
                        (r) => {
                          if (typeof r === "string") setPath(r);
                        },
                      )
                    }
                  >
                    浏览
                  </button>
                )}
              </div>
            </label>
            <p className="trust-note">
              <ShieldCheck size={16} />
              点击下方按钮表示信任此目录中的 pi 配置与扩展。
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setProjectDialog(false)}>
                取消
              </button>
              <button className="primary" disabled={busy || !path.trim()}>
                信任并添加
              </button>
            </div>
          </form>
        </div>
      )}
      {newDialog && (
        <div className="dialog-backdrop">
          <form
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={projectDialog ? "添加项目" : "新建任务"}
            onSubmit={(e) => {
              e.preventDefault();
              void createTask();
            }}
          >
            <h2>新建任务</h2>
            <p className="muted">{project?.name}</p>
            <label className="field">
              任务名称
              <input
                autoFocus
                value={taskName}
                onChange={(e) => setTaskName(e.target.value)}
                placeholder="例如：完善登录流程"
              />
            </label>
            <label className="field">
              模式
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="plan">规划：读取代码并给出方案</option>
                <option value="execute">执行：自主修改与运行</option>
              </select>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={isolated}
                onChange={(e) => setIsolated(e.target.checked)}
              />
              为 Git 项目创建独立 worktree
            </label>
            <p className="muted small">
              从当前 HEAD 创建 codex/ 分支。原目录未提交改动不会复制；非 Git
              项目使用原目录。
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setNewDialog(false)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                创建任务
              </button>
            </div>
          </form>
        </div>
      )}
      {history && (
        <div className="dialog-backdrop">
          <section
            className="dialog history-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="继续 CLI 会话"
          >
            <h2>继续 CLI 会话</h2>
            <p className="muted">保留原执行目录与对话历史。</p>
            <div className="history-list">
              {history.length === 0 && <p>此项目没有可恢复的 pi 会话。</p>}
              {history.map((h) => (
                <button
                  key={h.id}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const s = await api.newSession(
                        project!.id,
                        h.name,
                        false,
                        "execute",
                        { existing: h.file },
                      );
                      replaceSession(s);
                      changeSession(s);
                      setHistory(null);
                    })
                  }
                >
                  <div>
                    <strong>{h.name}</strong>
                    <small>
                      {h.messages} 条消息 ·{" "}
                      {new Date(h.updated).toLocaleString()}
                    </small>
                  </div>
                  <CornerDownRight size={16} />
                </button>
              ))}
            </div>
            <button onClick={() => setHistory(null)}>关闭</button>
          </section>
        </div>
      )}
      {transcript.dialogs[0] && (
        <Dialog
          key={transcript.dialogs[0].id}
          request={transcript.dialogs[0]}
          onRespond={(v) => {
            const request = transcript.dialogs[0];
            void api
              .rpc(active, {
                type: "extension_ui_response",
                id: request.id,
                ...v,
              })
              .then(() =>
                update(active, (t) => ({
                  ...t,
                  dialogs: t.dialogs.filter((d) => d.id !== request.id),
                })),
              )
              .catch((e) => report(String(e)));
          }}
        />
      )}
    </div>
  );
}
