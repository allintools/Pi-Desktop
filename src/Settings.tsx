import { useEffect, useState, useRef } from "react";
import { api, call } from "./api";
import type { Project, RuntimeInfo, DesktopEvent } from "./types";
import RuntimeSetup from "./RuntimeSetup";
import { AppearanceSettings } from "./theme/AppearanceSettings";
import {
  Palette,
  Server,
  Blocks,
  Network,
  KeyRound,
  RefreshCw,
  Download,
  Trash2,
  Save,
  ExternalLink,
} from "lucide-react";
type Props = {
  project?: Project;
  initialTab?: string;
  report: (s: string) => void;
  onProject: (p: Project) => void;
};
export default function Settings({
  project,
  report,
  onProject,
  initialTab = "appearance",
}: Props) {
  const [tab, setTab] = useState(initialTab),
    [scope, setScope] = useState("user"),
    [resources, setResources] = useState<any[]>([]),
    [providers, setProviders] = useState<any[]>([]),
    [config, setConfig] = useState<any>(),
    [text, setText] = useState(""),
    [source, setSource] = useState(""),
    [busy, setBusy] = useState(false),
    [runtime, setRuntime] = useState<RuntimeInfo>(),
    [node, setNode] = useState(project?.target.node || ""),
    [pi, setPi] = useState(project?.target.pi || ""),
    [resource, setResource] = useState(""),
    [job, setJob] = useState(""),
    [authPrompt, setAuthPrompt] = useState<any>(),
    [authValue, setAuthValue] = useState(""),
    [authEvents, setAuthEvents] = useState<any[]>([]),
    [authProvider, setAuthProvider] = useState(""),
    [authType, setAuthType] = useState("api-key");
  useEffect(() => setTab(initialTab), [initialTab]);
  const jobRef = useRef(job);
  jobRef.current = job;
  useEffect(
    () => () => {
      if (jobRef.current)
        void call("auth_cancel", { jobId: jobRef.current }).catch(() => {});
    },
    [],
  );
  const context = { projectId: project?.id };
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
  const load = async () => {
    if (!project) return;
    if (tab === "runtime") setRuntime(await api.request("detect", {}, context));
    if (tab === "resources")
      setResources(await api.request("resource.list", {}, context));
    if (tab === "auth")
      setProviders(await api.request("auth.list", {}, context));
    if (tab === "mcp" || tab === "models" || tab === "config") {
      const r = await api.request(
        "config.read",
        {
          scope: tab === "models" ? "user" : scope,
          name:
            tab === "mcp"
              ? "mcp.json"
              : tab === "models"
                ? "models.json"
                : "settings.json",
        },
        context,
      );
      setConfig(r);
      setText(JSON.stringify(r.data, null, 2));
    }
  };
  useEffect(() => {
    setConfig(undefined);
    void run(load);
  }, [tab, scope, project?.id]);
  useEffect(() => {
    setNode(project?.target.node || "");
    setPi(project?.target.pi || "");
  }, [project?.id]);
  useEffect(() => {
    let dispose = () => {};
    api
      .subscribe((e: DesktopEvent) => {
        if (e.sessionId !== job) return;
        if (e.kind === "job") {
          if (e.payload.type === "auth_prompt") {
            setAuthPrompt(e.payload);
            setAuthValue("");
          }
          if (e.payload.type === "auth_notify")
            setAuthEvents((v) => [...v, e.payload.event]);
          if (e.payload.ok !== undefined) {
            setAuthPrompt(undefined);
            setJob("");
            if (e.payload.ok) {
              report("认证成功，新的会话将使用此凭据。");
              void load();
            } else report(e.payload.error);
          }
        }
      })
      .then((off) => (dispose = off));
    return () => dispose();
  }, [job]);
  const nav = [
    ["appearance", "外观", Palette],
    ["runtime", "运行环境", Server],
    ["auth", "模型认证", KeyRound],
    ["models", "模型与端点", Server],
    ["resources", "技能与扩展", Blocks],
    ["mcp", "MCP", Network],
    ["config", "pi 设置", Blocks],
  ] as const;
  return (
    <div className="settings">
      <nav className="settings-nav">
        {nav.map(([id, name, Icon]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            <Icon size={16} />
            {name}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {tab === "appearance" ? (
          <AppearanceSettings />
        ) : !project && tab === "runtime" ? (
          <RuntimeSetup report={report} />
        ) : !project ? (
          <div className="quiet-empty">
            <h2>先添加一个项目</h2>
            <p>pi 配置属于具体的 Windows 或 WSL 执行环境。</p>
          </div>
        ) : (
          <>
            <div className="settings-heading">
              <div>
                <h2>{nav.find((n) => n[0] === tab)?.[1]}</h2>
                <p className="muted">
                  {project.name} ·{" "}
                  {project.target.kind === "wsl"
                    ? project.target.distro
                    : "Windows"}
                  {project.target.user ? " / " + project.target.user : ""}
                </p>
              </div>
              <button disabled={busy} onClick={() => void run(load)}>
                <RefreshCw size={14} />
                重新读取
              </button>
            </div>
            {tab === "runtime" && (
              <>
                <div className="runtime-status">
                  <strong>{runtime?.ready ? "pi 已就绪" : "环境待检测"}</strong>
                  <p>{runtime?.error}</p>
                  <dl>
                    <dt>Node</dt>
                    <dd>
                      {runtime?.nodeVersion || "—"} · {runtime?.node || "—"}
                    </dd>
                    <dt>pi</dt>
                    <dd>
                      {runtime?.version || "—"} · {runtime?.pi || "—"}
                    </dd>
                    <dt>Git</dt>
                    <dd>{runtime?.git || "未检测到"}</dd>
                    <dt>配置目录</dt>
                    <dd>{runtime?.agentDir || "—"}</dd>
                  </dl>
                </div>
                <label className="field">
                  Node 路径覆盖
                  <input
                    value={node}
                    onChange={(e) => setNode(e.target.value)}
                    placeholder="留空使用环境 PATH"
                  />
                </label>
                <label className="field">
                  pi CLI 路径覆盖
                  <input
                    value={pi}
                    onChange={(e) => setPi(e.target.value)}
                    placeholder="pi.cmd 或包中的 dist/bundle/cli.js"
                  />
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const p = await api.saveProject({
                        ...project,
                        target: {
                          ...project.target,
                          node: node || undefined,
                          pi: pi || undefined,
                        },
                      });
                      onProject(p);
                      setRuntime(
                        await api.request("detect", {}, { projectId: p.id }),
                      );
                    })
                  }
                >
                  <Save size={14} />
                  保存并检测
                </button>
                <p className="muted">
                  应用依赖此环境已经安装的 Node ≥22.19、pi 1.1.0 兼容版本和
                  Git。不会自动升级它们。
                </p>
                <pre>npm install -g @earendil-works/pi-coding-agent</pre>
                <p className="muted">
                  WSL 中请使用普通 Linux 用户安装，Node、pi 和 Git 需要在该用户
                  PATH 中可用。
                </p>
              </>
            )}
            {tab === "auth" && (
              <>
                <p className="muted">
                  认证由此环境的 pi SDK 保存。Windows 与 WSL 的账号分别管理。
                </p>
                <div className="provider-list">
                  {providers.map((p) => (
                    <div key={p.id} className="provider-row">
                      <div>
                        <strong>{p.name}</strong>
                        <small className="muted">
                          {p.id} · {p.configured ? "已配置" : "未配置"}
                        </small>
                      </div>
                      <button
                        disabled={!!job}
                        onClick={() => {
                          setAuthProvider(p.id);
                          setAuthType(
                            p.methods.includes("oauth") ? "oauth" : "api-key",
                          );
                          setAuthEvents([]);
                        }}
                      >
                        登录
                      </button>
                      {p.configured && (
                        <button
                          disabled={busy || !!job}
                          onClick={() =>
                            void run(async () => {
                              if (
                                window.confirm("退出 " + p.name + " 的认证？")
                              ) {
                                await api.request(
                                  "auth.logout",
                                  { provider: p.id },
                                  context,
                                );
                                await load();
                              }
                            })
                          }
                        >
                          退出认证
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {authProvider && (
                  <section className="auth-panel">
                    <h3>登录 {authProvider}</h3>
                    <label className="field">
                      认证方式
                      <select
                        value={authType}
                        disabled={!!job}
                        onChange={(e) => setAuthType(e.target.value)}
                      >
                        {providers
                          .find((p) => p.id === authProvider)
                          ?.methods.map((method: string) => (
                            <option
                              key={method}
                              value={method === "apiKey" ? "api-key" : method}
                            >
                              {method === "apiKey" ? "API Key" : "OAuth"}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button
                      disabled={busy || !!job}
                      onClick={() =>
                        void run(async () => {
                          setJob(
                            await call("auth_start", {
                              projectId: project.id,
                              provider: authProvider,
                              authType,
                            }),
                          );
                        })
                      }
                    >
                      开始认证
                    </button>
                    {job && (
                      <button
                        onClick={() =>
                          void call("auth_cancel", { jobId: job }).then(() => {
                            setJob("");
                            setAuthPrompt(undefined);
                          })
                        }
                      >
                        取消认证
                      </button>
                    )}
                    {authEvents.map((e, i) => (
                      <div key={i} className="auth-event">
                        <p>{e.message || e.instructions || e.userCode}</p>
                        {(e.url || e.verificationUri) && (
                          <button
                            onClick={() =>
                              void call("open_url", {
                                url: e.url || e.verificationUri,
                              }).catch((e) => report(String(e)))
                            }
                          >
                            <ExternalLink size={14} />
                            打开认证页面
                          </button>
                        )}
                      </div>
                    ))}
                    {authPrompt && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void call("auth_response", {
                            jobId: job,
                            id: authPrompt.id,
                            value: authValue,
                          })
                            .then(() => {
                              setAuthPrompt(undefined);
                              setAuthValue("");
                            })
                            .catch((e) => report(String(e)));
                        }}
                      >
                        <label className="field">
                          {authPrompt.prompt.message}
                          {authPrompt.prompt.type === "select" ? (
                            <select
                              value={authValue}
                              onChange={(e) => setAuthValue(e.target.value)}
                            >
                              <option value="">请选择</option>
                              {authPrompt.prompt.options?.map((o: any) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              autoFocus
                              type={
                                authPrompt.prompt.type === "secret"
                                  ? "password"
                                  : "text"
                              }
                              autoComplete="off"
                              value={authValue}
                              onChange={(e) => setAuthValue(e.target.value)}
                            />
                          )}
                        </label>
                        <button disabled={!authValue}>继续</button>
                      </form>
                    )}
                  </section>
                )}
              </>
            )}
            {tab === "resources" && (
              <>
                <label className="field">
                  作用范围
                  <select
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                  >
                    <option value="user">当前环境用户</option>
                    <option value="project">当前项目</option>
                  </select>
                </label>
                <div className="package-install">
                  <input
                    aria-label="包来源"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="npm:@scope/package@version、git:… 或本地路径"
                  />
                  <button
                    disabled={busy || !source.trim()}
                    onClick={() =>
                      void run(async () => {
                        await api.request(
                          "package.install",
                          { source, scope },
                          context,
                        );
                        setSource("");
                        await load();
                        report("包已安装，重连会话后生效。");
                      })
                    }
                  >
                    <Download size={14} />
                    安装
                  </button>
                </div>
                <div className="resource-list">
                  {resources.length === 0 && (
                    <p className="muted">
                      此环境尚未发现技能、扩展或提示模板。
                    </p>
                  )}
                  {resources.map((r, i) => (
                    <div className="resource-row" key={i}>
                      <div>
                        <strong>{r.name}</strong>
                        <small className="muted">
                          {r.kind} · {r.scope === "user" ? "用户" : "项目"} ·{" "}
                          {typeof r.source === "string"
                            ? r.source
                            : JSON.stringify(r.source)}
                        </small>
                      </div>
                      {r.kind !== "package" ? (
                        <>
                          <button
                            onClick={() =>
                              void run(async () =>
                                setResource(
                                  (
                                    await api.request(
                                      "resource.read",
                                      { path: r.path },
                                      context,
                                    )
                                  ).text,
                                ),
                              )
                            }
                          >
                            查看
                          </button>
                          <button
                            aria-label={"移除 " + r.name}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                if (
                                  !window.confirm("移除此资源并保留本机备份？")
                                )
                                  return;
                                const result = await api.request(
                                  "resource.remove",
                                  { source: r.source },
                                  context,
                                );
                                report("资源已移除，备份：" + result.backup);
                                await load();
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await api.request(
                                  "resource.toggle",
                                  {
                                    kind: r.kind,
                                    scope: r.scope,
                                    source: r.source,
                                    enabled: !r.enabled,
                                  },
                                  context,
                                );
                                await load();
                                report("资源设置已保存，重连后生效。");
                              })
                            }
                          >
                            {r.enabled === false ? "启用" : "禁用"}
                          </button>
                        </>
                      ) : (
                        <button
                          disabled={busy}
                          aria-label={"移除 " + r.name}
                          onClick={() =>
                            void run(async () => {
                              if (window.confirm("移除此 pi 包？")) {
                                await api.request(
                                  "package.remove",
                                  { source: r.source, scope: r.scope },
                                  context,
                                );
                                await load();
                              }
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {resource && (
                  <details open>
                    <summary>资源内容</summary>
                    <pre className="resource-content">{resource}</pre>
                  </details>
                )}
                <p className="muted">
                  RPC 支持扩展的选择、确认、输入及编辑请求。依赖终端专属 UI
                  的扩展请在终端运行 pi。
                </p>
              </>
            )}
            {["mcp", "models", "config"].includes(tab) && (
              <>
                <label className="field">
                  配置范围
                  <select
                    value={tab === "models" ? "user" : scope}
                    onChange={(e) => setScope(e.target.value)}
                  >
                    <option value="user">当前环境用户</option>
                    <option value="project" disabled={tab === "models"}>
                      当前项目
                    </option>
                  </select>
                </label>
                <p className="muted">
                  {config?.path}。保留未修改的顶层字段，保存前检查外部变更。
                </p>
                {tab === "mcp" && (
                  <p className="muted">
                    支持 stdio 和 streamable HTTP。编辑 mcpServers
                    配置；规划模式不连接 MCP。
                  </p>
                )}
                <textarea
                  className="config-editor"
                  aria-label="JSON 配置"
                  spellCheck={false}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <div className="row">
                  <button
                    disabled={busy || !config}
                    onClick={() =>
                      void run(async () => {
                        const data = JSON.parse(text);
                        const r = await api.request(
                          "config.save",
                          {
                            scope: tab === "models" ? "user" : scope,
                            name:
                              tab === "mcp"
                                ? "mcp.json"
                                : tab === "models"
                                  ? "models.json"
                                  : "settings.json",
                            data,
                            revision: config.revision,
                          },
                          context,
                        );
                        setConfig(r);
                        report("配置已保存，重连会话后生效。");
                      })
                    }
                  >
                    <Save size={14} />
                    保存配置
                  </button>
                  {tab === "mcp" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () =>
                          setResource(
                            JSON.stringify(
                              await api.request("mcp.check", {}, context),
                              null,
                              2,
                            ),
                          ),
                        )
                      }
                    >
                      <Network size={14} />
                      检查连接
                    </button>
                  )}
                </div>
                {tab === "mcp" && (
                  <>
                    <label className="field">
                      MCP 服务名称
                      <input
                        value={source}
                        onChange={(e) => setSource(e.target.value)}
                        placeholder="mcpServers 中的名称"
                      />
                    </label>
                    <div className="row">
                      <button
                        disabled={busy || !!job || !source.trim()}
                        onClick={() =>
                          void run(async () => {
                            setAuthEvents([]);
                            setJob(
                              await call("auth_start", {
                                projectId: project.id,
                                provider: source.trim(),
                                authType: "mcp",
                              }),
                            );
                          })
                        }
                      >
                        OAuth 登录
                      </button>
                      <button
                        disabled={busy || !source.trim()}
                        onClick={() =>
                          void run(async () => {
                            await api.request(
                              "mcp.logout",
                              { provider: source.trim() },
                              context,
                            );
                            report("MCP 认证已退出");
                          })
                        }
                      >
                        退出认证
                      </button>
                      {job && (
                        <button
                          onClick={() =>
                            void call("auth_cancel", { jobId: job }).then(() =>
                              setJob(""),
                            )
                          }
                        >
                          取消登录
                        </button>
                      )}
                    </div>
                    {authEvents.map((e, i) => (
                      <div key={i}>
                        <p>{e.url ? "在浏览器中授权此 MCP 服务" : e.message}</p>
                        {e.url && (
                          <button
                            onClick={() =>
                              void call("open_url", { url: e.url })
                            }
                          >
                            打开认证页面
                          </button>
                        )}
                      </div>
                    ))}
                    {resource && (
                      <pre className="resource-content">{resource}</pre>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
