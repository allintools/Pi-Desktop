import { useEffect, useState } from "react";
import { api, call, native } from "./api";
import type { Target, RuntimeInfo } from "./types";
const key = "pi-desktop.runtime-targets.v1";
const identity = (t: Target) =>
  [t.kind, t.distro || "", t.user || ""].join("/");
function saved(): Record<string, Target> {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
export function rememberedTarget(t: Target): Target {
  return { ...saved()[identity(t)], ...t };
}
export default function RuntimeSetup({
  report,
}: {
  report: (s: string) => void;
}) {
  const [target, setTarget] = useState<Target>(() =>
      rememberedTarget({ kind: "windows" }),
    ),
    [distros, setDistros] = useState<string[]>([]),
    [results, setResults] = useState<Record<string, RuntimeInfo>>({}),
    [busy, setBusy] = useState(false);
  const scan = async (t: Target) => {
    try {
      const info = await api.request("detect", {}, { target: t });
      setResults((v) => ({ ...v, [identity(t)]: info }));
    } catch (e) {
      setResults((v) => ({
        ...v,
        [identity(t)]: { target: t, ready: false, error: String(e) },
      }));
    }
  };
  useEffect(() => {
    if (!native) return;
    setBusy(true);
    void (async () => {
      const ds = await call<string[]>("distributions").catch(() => []);
      setDistros(ds);
      await Promise.allSettled([
        scan(rememberedTarget({ kind: "windows" })),
        ...ds.map((distro) => scan(rememberedTarget({ kind: "wsl", distro }))),
      ]);
      setBusy(false);
    })();
  }, []);
  return (
    <section>
      <h2>运行环境</h2>
      <p className="muted">
        检测已有 Node、pi 和 Git。每个 WSL 发行版使用自己的 Linux 安装。
      </p>
      <div className="provider-list">
        {Object.entries(results).map(([id, r]) => (
          <div className="provider-row" key={id}>
            <div>
              <strong>
                {id.startsWith("windows") ? "Windows" : id.split("/")[1]} ·{" "}
                {r.ready ? "已就绪" : "需要配置"}
              </strong>
              <small>
                {r.error ||
                  `Node ${r.nodeVersion} · pi ${r.version} · ${r.git ? "Git 已安装" : "未找到 Git"}`}
              </small>
            </div>
          </div>
        ))}
      </div>
      {busy && <p role="status">正在检测环境…</p>}
      <label className="field">
        配置环境
        <select
          value={target.kind === "windows" ? "windows" : target.distro}
          onChange={(e) =>
            setTarget(
              rememberedTarget(
                e.target.value === "windows"
                  ? { kind: "windows" }
                  : { kind: "wsl", distro: e.target.value },
              ),
            )
          }
        >
          <option value="windows">Windows</option>
          {distros.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      </label>
      {target.kind === "wsl" && (
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
            placeholder="留空使用默认用户"
          />
        </label>
      )}
      <label className="field">
        Node 路径
        <input
          value={target.node || ""}
          onChange={(e) =>
            setTarget((t) => ({ ...t, node: e.target.value || undefined }))
          }
          placeholder="留空使用 PATH"
        />
      </label>
      <label className="field">
        pi CLI 路径
        <input
          value={target.pi || ""}
          onChange={(e) =>
            setTarget((t) => ({ ...t, pi: e.target.value || undefined }))
          }
          placeholder="pi.cmd 或 dist/bundle/cli.js"
        />
      </label>
      <button
        disabled={busy || !native}
        onClick={() => {
          try {
            localStorage.setItem(
              key,
              JSON.stringify({ ...saved(), [identity(target)]: target }),
            );
            void scan(target);
            report("路径已保存，新添加的项目会使用这些设置。");
          } catch {
            report("无法保存运行环境路径，请检查本地存储。");
          }
        }}
      >
        保存并重新检测
      </button>
      <p className="muted">
        需要 Node ≥22.19。安装 pi 后重新检测，然后从左侧添加项目。
      </p>
      <pre>npm install -g @earendil-works/pi-coding-agent</pre>
    </section>
  );
}
