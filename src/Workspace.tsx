import { useEffect, useRef, useState } from "react";
import { Editor, DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import {
  Files,
  GitCompareArrows,
  TerminalSquare,
  ChevronRight,
  Folder,
  FileText,
  RefreshCw,
  Save,
  Plus,
  Minus,
  GitCommitHorizontal,
  ArrowLeftToLine,
  Unplug,
} from "lucide-react";
import { api, call, native } from "./api";
import type { Project, Session } from "./types";
import { useTheme } from "./theme/ThemeProvider";
import { presets } from "./theme/config";
(globalThis as any).MonacoEnvironment = {
  getWorker: (_: unknown, label: string) => {
    if (["typescript", "javascript"].includes(label)) return new TsWorker();
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label))
      return new HtmlWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
type Entry = { name: string; path: string; directory: boolean };
function FileTree({
  session,
  dir = "",
  depth = 0,
  onFile,
  report,
}: {
  session: Session;
  dir?: string;
  depth?: number;
  onFile: (p: string) => void;
  report: (s: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .request("file.list", { path: dir || "." }, { sessionId: session.id })
      .then((r) => {
        if (alive) setEntries(r);
      })
      .catch((e) => {
        if (alive) report(String(e));
      });
    return () => {
      alive = false;
    };
  }, [session.id, dir]);
  return (
    <>
      {entries.map((e) => (
        <div key={e.path}>
          <button
            className="tree-row"
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() =>
              e.directory
                ? setExpanded((x) =>
                    x.includes(e.path)
                      ? x.filter((v) => v !== e.path)
                      : [...x, e.path],
                  )
                : onFile(e.path)
            }
            title={e.path}
          >
            {e.directory ? (
              <>
                <ChevronRight
                  size={12}
                  className={expanded.includes(e.path) ? "rotated" : ""}
                />
                <Folder size={14} />
              </>
            ) : (
              <>
                <span className="tree-spacer" />
                <FileText size={14} />
              </>
            )}
            <span>{e.name}</span>
          </button>
          {e.directory && expanded.includes(e.path) && (
            <FileTree
              session={session}
              dir={e.path}
              depth={depth + 1}
              onFile={onFile}
              report={report}
            />
          )}
        </div>
      ))}
    </>
  );
}
function language(name: string) {
  const extension = name.split(".").pop();
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        json: "json",
        rs: "rust",
        py: "python",
        md: "markdown",
        css: "css",
        html: "html",
        sh: "shell",
        go: "go",
        toml: "ini",
      } as Record<string, string>
    )[extension || ""] || "plaintext"
  );
}
export function TerminalPane({
  session,
  report,
}: {
  session: Session;
  report: (s: string) => void;
}) {
  const node = useRef<HTMLDivElement>(null),
    term = useRef<Terminal | undefined>(undefined),
    [id, setId] = useState("");
  const { preferences } = useTheme();
  useEffect(() => {
    if (!native || !node.current) return;
    const earlyOutput: Record<string, string[]> = {};
    let closed = false,
      terminalId = "",
      off: (() => void)[] = [];
    const t = new Terminal({
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(node.current);
    term.current = t;
    const resize = () => {
      try {
        fit.fit();
        if (terminalId)
          void call("terminal_resize", {
            id: terminalId,
            cols: t.cols,
            rows: t.rows,
          }).catch(() => {});
      } catch {}
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node.current);
    void (async () => {
      off.push(
        await listen<any>("terminal-data", (e) => {
          if (!terminalId) {
            (earlyOutput[e.payload.id] ??= []).push(e.payload.data);
            return;
          }
          if (e.payload.id === terminalId)
            t.write(
              Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0)),
            );
        }),
      );
      off.push(
        await listen<any>("terminal-exit", (e) => {
          if (e.payload.id === terminalId) t.writeln("\r\n[终端已退出]");
        }),
      );
      terminalId = await call<string>("terminal_open", {
        sessionId: session.id,
      });
      if (closed) {
        void call("terminal_close", { id: terminalId });
        return;
      }
      setId(terminalId);
      resize();
      t.onData(
        (data) =>
          void call("terminal_write", { id: terminalId, data }).catch((e) =>
            report(String(e)),
          ),
      );
      for (const data of earlyOutput[terminalId] || [])
        t.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    })().catch((e) => report(String(e)));
    return () => {
      closed = true;
      off.forEach((f) => f());
      observer.disconnect();
      if (terminalId)
        void call("terminal_close", { id: terminalId }).catch(() => {});
      t.dispose();
      term.current = undefined;
    };
  }, [session.id]);
  useEffect(() => {
    const p = presets[preferences.preset].tokens;
    if (term.current)
      term.current.options.theme = {
        background: p.terminal,
        foreground: p.terminalText,
        cursor: p.accent,
        selectionBackground: p.selection,
        black: p.terminal,
        red: p.danger,
        green: p.accent,
        yellow: p.amber,
        blue: p.blue,
        magenta: p.magenta,
        cyan: p.cyan,
        white: p.text,
        brightBlack: p.muted,
        brightRed: p.danger,
        brightGreen: p.accent,
        brightYellow: p.amber,
        brightBlue: p.blue,
        brightMagenta: p.magenta,
        brightCyan: p.cyan,
        brightWhite: p.text,
      };
  }, [preferences.preset, id]);
  return (
    <div className="terminal-shell">
      <div className="workspace-note">
        {session.cwd} · {id ? "已连接" : "连接中…"}
      </div>
      <div ref={node} className="terminal-host" />
    </div>
  );
}
export default function Workspace({
  session,
  project,
  report,
}: {
  session: Session;
  project: Project;
  report: (s: string) => void;
}) {
  const [targetBranch, setTargetBranch] = useState(""),
    [targetGit, setTargetGit] = useState<any>();
  const [tab, setTab] = useState("files"),
    [terminalVisited, setTerminalVisited] = useState(false),
    [file, setFile] = useState(""),
    [content, setContent] = useState(""),
    [saved, setSaved] = useState(""),
    [revision, setRevision] = useState(""),
    [treeKey, setTreeKey] = useState(0),
    [git, setGit] = useState<any>(),
    [diff, setDiff] = useState<any>(),
    [diffPath, setDiffPath] = useState(""),
    [diffStaged, setDiffStaged] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const { preferences } = useTheme();
  const tokens = presets[preferences.preset].tokens;
  useEffect(() => {
    monaco.editor.defineTheme("pi-desktop", {
      base: presets[preferences.preset].dark ? "vs-dark" : "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": tokens.terminal,
        "editor.foreground": tokens.text,
        "editor.selectionBackground": tokens.selection,
        "editorLineNumber.foreground": tokens.muted,
        "editorCursor.foreground": tokens.accent,
        "editorWidget.background": tokens.terminal,
        "editorWidget.border": tokens.border,
        "editorHoverWidget.background": tokens.terminal,
        "editorHoverWidget.foreground": tokens.text,
        "input.background": tokens.input,
        "input.foreground": tokens.text,
        focusBorder: tokens.accent,
        "diffEditor.insertedTextBackground": tokens.accent + "28",
        "diffEditor.removedTextBackground": tokens.danger + "28",
      },
    });
    monaco.editor.setTheme("pi-desktop");
  }, [preferences.preset]);
  useEffect(() => {
    setFile("");
    setContent("");
    setSaved("");
    setDiff(undefined);
    setGit(undefined);
  }, [session.id]);
  const action = async (task: () => Promise<any>) => {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      report(String(e));
    } finally {
      setBusy(false);
    }
  };
  const loadGit = async () => {
    setGit(await api.request("git.status", {}, { sessionId: session.id }));
    if (session.worktree) {
      const target = await api.request(
        "git.status",
        {},
        { projectId: project.id },
      );
      setTargetGit(target);
      setTargetBranch((current) => current || target.branch);
    }
  };
  useEffect(() => {
    if (tab === "diff") void action(loadGit);
  }, [tab, session.id]);
  const open = async (p: string) => {
    if (
      content !== saved &&
      !window.confirm("当前文件有未保存内容，放弃并打开其他文件？")
    )
      return;
    await action(async () => {
      const result = await api.request(
        "file.read",
        { path: p },
        { sessionId: session.id },
      );
      setFile(p);
      setContent(result.text);
      setSaved(result.text);
      setRevision(result.revision);
    });
  };
  const changeGit = (type: string, args: any) =>
    action(async () => {
      await api.request(type, args, { sessionId: session.id });
      await loadGit();
    });
  const showDiff = (p: string, staged = false, original?: string) =>
    action(async () => {
      setDiffPath(p);
      setDiffStaged(staged);
      setDiff(
        await api.request(
          "git.diff",
          { path: p, staged, original },
          { sessionId: session.id },
        ),
      );
    });
  return (
    <aside className="workspace">
      <nav className="workspace-tabs" aria-label="工作区">
        <button
          className={tab === "files" ? "active" : ""}
          onClick={() => setTab("files")}
        >
          <Files size={15} />
          文件
        </button>
        <button
          className={tab === "diff" ? "active" : ""}
          onClick={() => setTab("diff")}
        >
          <GitCompareArrows size={15} />
          Diff
        </button>
        <button
          className={tab === "terminal" ? "active" : ""}
          onClick={() => {
            setTab("terminal");
            setTerminalVisited(true);
          }}
        >
          <TerminalSquare size={15} />
          终端
        </button>
      </nav>
      <div className="workspace-body" hidden={tab !== "files"}>
        <div className="panel-tools">
          <span>工作区文件</span>
          <button
            aria-label="刷新文件树"
            onClick={() => setTreeKey((k) => k + 1)}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="file-tree">
          <FileTree
            key={treeKey + session.id}
            session={session}
            onFile={(p) => void open(p)}
            report={report}
          />
        </div>
        {file ? (
          <>
            <div className="panel-tools">
              <span title={file}>
                {file}
                {content !== saved ? " *" : ""}
              </span>
              <button
                disabled={busy || content === saved}
                onClick={() =>
                  void action(async () => {
                    const r = await api.request(
                      "file.write",
                      { path: file, text: content, revision },
                      { sessionId: session.id },
                    );
                    setSaved(content);
                    setRevision(r.revision);
                  })
                }
              >
                <Save size={14} />
                保存
              </button>
            </div>
            <div className="editor-host">
              <Editor
                path={session.id + "/" + file}
                value={content}
                onChange={(v) => setContent(v || "")}
                language={language(file)}
                theme="pi-desktop"
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                }}
              />
            </div>
          </>
        ) : (
          <div className="quiet-empty">选择文件查看或编辑</div>
        )}
      </div>
      <div className="workspace-body git-body" hidden={tab !== "diff"}>
        <div className="panel-tools">
          <span>{git?.branch || "Git 工作区"}</span>
          <button
            disabled={busy}
            aria-label="刷新 Git"
            onClick={() => void action(loadGit)}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {git && (
          <>
            <label className="branch-select">
              分支
              <select
                value={git.branch}
                disabled={busy}
                onChange={(e) =>
                  void changeGit("git.checkout", { branch: e.target.value })
                }
              >
                {git.branches.map((b: string) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <div className="git-files">
              {git.files.length === 0 && (
                <p className="muted">工作区没有待提交修改</p>
              )}
              {git.files.map((f: any) => (
                <div key={f.path} className="git-file">
                  <button onClick={() => void showDiff(f.path, false)}>
                    <code>{f.status}</code>
                    <span title={f.path}>{f.path}</span>
                  </button>
                  <button
                    aria-label={"查看已暂存差异 " + f.path}
                    title="查看已暂存差异"
                    disabled={f.status[0] === " " || f.status === "??"}
                    onClick={() => void showDiff(f.path, true, f.original)}
                  >
                    已暂存
                  </button>
                  <button
                    title="暂存"
                    aria-label={"暂存 " + f.path}
                    disabled={busy}
                    onClick={() =>
                      void changeGit("git.stage", { paths: [f.path] })
                    }
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    title="取消暂存"
                    aria-label={"取消暂存 " + f.path}
                    disabled={busy || f.status[0] === " " || f.status === "??"}
                    onClick={() =>
                      void changeGit("git.unstage", { paths: [f.path] })
                    }
                  >
                    <Minus size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="commit-box">
              <input
                aria-label="提交说明"
                placeholder="提交说明"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button
                disabled={busy || !message.trim()}
                onClick={() =>
                  void changeGit("git.commit", { message }).then(() =>
                    setMessage(""),
                  )
                }
              >
                <GitCommitHorizontal size={14} />
                提交已暂存内容
              </button>
            </div>
          </>
        )}
        {diff && (
          <>
            <div className="workspace-note">
              {diffStaged ? "已暂存" : "工作区"} · {diffPath}
            </div>
            <div className="diff-host">
              <DiffEditor
                original={diff.before}
                modified={diff.after}
                language={language(diffPath)}
                theme="pi-desktop"
                options={{
                  readOnly: true,
                  renderSideBySide: false,
                  minimap: { enabled: false },
                  automaticLayout: true,
                  fontSize: 12,
                }}
              />
            </div>
          </>
        )}
        {session.worktree && git && (
          <details className="bringback">
            <summary>将提交带回原项目</summary>
            <p className="muted small">
              目标：{project.path}。冲突保留在目标目录，手动解决后继续。
            </p>
            <label className="field">
              目标分支
              <select
                value={targetBranch}
                onChange={(e) => setTargetBranch(e.target.value)}
              >
                {targetGit?.branches.map((b: string) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            {git.log.map((entry: any) => (
              <button
                key={entry.id}
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (
                      !window.confirm(
                        "将此提交应用到目标分支 " +
                          targetBranch +
                          "？\n" +
                          entry.subject,
                      )
                    )
                      return;
                    const r = await api.request(
                      "git.cherryPick",
                      { commit: entry.id, targetBranch },
                      { projectId: project.id },
                    );
                    report(
                      r.conflict
                        ? "目标项目存在 cherry-pick 冲突。请在原目录会话中解决，或点击中止。"
                        : r.output
                          ? "Git：" + r.output
                          : "提交已应用到原项目。",
                    );
                  })
                }
              >
                <ArrowLeftToLine size={13} />
                {entry.id.slice(0, 7)} {entry.subject}
              </button>
            ))}
            <button
              onClick={() =>
                void action(async () => {
                  const result = await api.request(
                    "git.cherryContinue",
                    {},
                    { projectId: project.id },
                  );
                  report(String(result));
                })
              }
            >
              解决冲突后继续 cherry-pick
            </button>
            <button
              onClick={() =>
                void action(async () => {
                  await api.request(
                    "git.cherryAbort",
                    {},
                    { projectId: project.id },
                  );
                  report("已中止目标目录的 cherry-pick");
                })
              }
            >
              中止目标目录 cherry-pick
            </button>
            <button
              onClick={() =>
                void action(async () => {
                  await call("runtime_close", { id: session.id });
                  await api.request(
                    "git.worktreeRemove",
                    {
                      targetBranch:
                        window.prompt("已合入哪个目标分支？", "main") || "main",
                    },
                    { sessionId: session.id },
                  );
                  report("工作区已安全移除，会话历史保留。");
                })
              }
            >
              <Unplug size={13} />
              安全移除 worktree
            </button>
          </details>
        )}
      </div>
      <div className="workspace-body terminal-body" hidden={tab !== "terminal"}>
        {terminalVisited && <TerminalPane session={session} report={report} />}
      </div>
    </aside>
  );
}
