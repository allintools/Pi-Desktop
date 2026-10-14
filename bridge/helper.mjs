import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_FILE = 8 * 1024 * 1024;
export const hash = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");
export async function command(exe, args, cwd, limit = 16 * 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      shell: false,
    });
    let out = [],
      err = [],
      size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("操作超时，请检查环境或网络。"));
    }, 120000);
    child.stdout.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        child.kill();
        reject(new Error("输出超过限制，请缩小操作范围。"));
      } else out.push(d);
    });
    child.stderr.on("data", (d) => {
      if (err.reduce((n, b) => n + b.length, 0) < 65536) err.push(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8"),
        stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve(stdout);
      else
        reject(new Error(stderr.trim() || stdout.trim() || `命令退出 ${code}`));
    });
  });
}
async function locate(name) {
  if (process.platform === "win32") {
    try {
      return (await command("where.exe", [name])).trim().split(/\r?\n/)[0];
    } catch {
      return "";
    }
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      await fs.access(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return "";
}
export async function discover(overrides = {}) {
  const node = overrides.node || process.execPath;
  let cli =
    overrides.pi ||
    (await locate(process.platform === "win32" ? "pi.cmd" : "pi"));
  let packageDir = "";
  if (cli) {
    if (/\.(cmd|ps1)$/i.test(cli)) {
      const text = await fs.readFile(cli, "utf8");
      const match = text.match(
        /node_modules[\\/](@[^\\/"']+[\\/][^\\/"']+)[\\/]dist[\\/]([^"'\s]+)/,
      );
      if (match) {
        packageDir = path.join(path.dirname(cli), "node_modules", match[1]);
        cli = path.join(packageDir, "dist", match[2]);
      }
    } else {
      try {
        cli = await fs.realpath(cli);
      } catch {}
    }
    if (!packageDir) {
      let dir = path.dirname(cli);
      for (let i = 0; i < 5; i++, dir = path.dirname(dir)) {
        try {
          const pkg = JSON.parse(
            await fs.readFile(path.join(dir, "package.json"), "utf8"),
          );
          if (pkg.name?.endsWith("/pi-coding-agent")) {
            packageDir = dir;
            break;
          }
        } catch {}
      }
    }
  }
  const pkg = packageDir
    ? JSON.parse(
        await fs.readFile(path.join(packageDir, "package.json"), "utf8"),
      )
    : {};
  const git = await locate("git");
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const version = pkg.version || "";
  const ready =
    !!cli &&
    !!packageDir &&
    (Number(process.versions.node.split(".")[0]) > 22 ||
      (Number(process.versions.node.split(".")[0]) === 22 &&
        Number(process.versions.node.split(".")[1]) >= 19)) &&
    /^(?:1\.[1-9]\d*\.|[2-9]\d*\.)/.test(version);
  return {
    node,
    nodeVersion: process.versions.node,
    pi: cli,
    packageDir,
    git,
    home: os.homedir(),
    agentDir,
    version,
    ready,
    error: ready
      ? ""
      : !cli
        ? "未找到 pi。请安装 @earendil-works/pi-coding-agent 后重新检测。"
        : "需要 Node ≥22.19 和兼容 pi（基线 1.1.0）。",
  };
}
let sdkPromise;
async function sdk(info) {
  return (sdkPromise ??= import(
    pathToFileURL(path.join(info.packageDir, "dist", "index.js")).href
  ));
}
export async function within(root, relative = ".") {
  const base = await fs.realpath(root),
    requested = path.resolve(base, relative);
  let resolved;
  try {
    resolved = await fs.realpath(requested);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    resolved = path.join(
      await fs.realpath(path.dirname(requested)),
      path.basename(requested),
    );
  }
  const rel = path.relative(base, resolved);
  if (rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel))
    throw new Error("路径超出当前工作区。");
  return resolved;
}
async function git(root, args) {
  return command("git", ["-C", root, ...args], undefined);
}
export function parseStatus(text) {
  const records = text.split("\0"),
    result = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    const status = row.slice(0, 2),
      name = row.slice(3);
    const original = /[RC]/.test(status) ? records[++i] : undefined;
    result.push({ status, path: name, original });
  }
  return result;
}
async function configPath(info, cwd, scope, name) {
  if (!["settings.json", "models.json", "mcp.json"].includes(name))
    throw new Error("不支持的配置文件。");
  if (name === "models.json" && scope === "project")
    throw new Error("models.json 属于环境用户配置。");
  const base = scope === "project" ? path.join(cwd, ".pi") : info.agentDir;
  await fs.mkdir(base, { recursive: true });
  return path.join(base, name);
}
export async function readConfig(file) {
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return { data: raw ? JSON.parse(raw) : {}, revision: hash(raw), path: file };
}
export async function saveConfig(file, data, revision) {
  const current = await readConfig(file);
  if (current.revision !== revision)
    throw new Error("配置已被其他程序修改，请重新读取后保存。");
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("配置必须为 JSON 对象。");
  const output = JSON.stringify({ ...current.data, ...data }, null, 2) + "\n",
    tmp = file + "." + crypto.randomUUID() + ".tmp";
  await fs.writeFile(tmp, output, { mode: 0o600 });
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return { data: JSON.parse(output), revision: hash(output), path: file };
}
async function resources(info, cwd) {
  const list = [];
  for (const [scope, base] of [
    ["user", info.agentDir],
    ["project", path.join(cwd, ".pi")],
    ["user", path.join(info.home, ".agents")],
    ["project", path.join(cwd, ".agents")],
  ]) {
    const agentSkills = path.basename(base) === ".agents";
    const configBase = agentSkills
      ? scope === "user"
        ? info.agentDir
        : path.join(cwd, ".pi")
      : base;
    const settings = await readConfig(path.join(configBase, "settings.json"));
    for (const kind of agentSkills
      ? ["skills"]
      : ["skills", "extensions", "prompts"]) {
      const dir = path.join(base, kind);
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {}
      for (const e of entries) {
        const file = e.isDirectory()
          ? path.join(
              dir,
              e.name,
              kind === "skills" ? "SKILL.md" : "package.json",
            )
          : path.join(dir, e.name);
        list.push({
          name: e.name,
          kind,
          scope,
          path: file,
          source: path.join(dir, e.name),
          enabled: !(settings.data[kind] || []).includes(
            "-" + path.join(dir, e.name),
          ),
        });
      }
    }
    if (!agentSkills)
      for (const source of settings.data.packages || [])
        list.push({
          name: typeof source === "string" ? source : source.source,
          kind: "package",
          scope,
          source,
        });
  }
  return list;
}
async function sessionInfo(manager) {
  const file = manager.getSessionFile() || "";
  if (file) {
    try {
      await fs.writeFile(
        file,
        [manager.getHeader(), ...manager.getEntries()]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  return {
    id: manager.getSessionId(),
    file,
    cwd: manager.getCwd(),
    name: manager.getSessionName() || "新任务",
  };
}
export async function dispatch(
  req,
  emit = () => {},
  ask = async () => {
    throw new Error("认证需要交互");
  },
) {
  const a = req.args || {},
    info = await discover(req.target || {}),
    cwd = a.cwd || process.cwd();
  if (req.action === "detect") {
    if (info.ready) {
      try {
        const lib = await sdk(info),
          help = await command(info.node, [info.pi, "--help"]);
        info.capabilities = {
          sdk:
            typeof lib.SessionManager?.create === "function" &&
            typeof lib.ModelRuntime?.create === "function",
          rpc: /--mode[^\n]*rpc/.test(help),
          readOnly: ["--tools", "--no-extensions", "--no-mcp"].every((flag) =>
            help.includes(flag),
          ),
        };
        info.ready = Object.values(info.capabilities).every(Boolean);
        if (!info.ready)
          info.error = "此 pi 安装缺少桌面端需要的 SDK 或 RPC 能力。";
      } catch (e) {
        info.ready = false;
        info.error = "pi 兼容性检查失败：" + e.message;
      }
    }
    return info;
  }
  if (req.action === "plan.check") {
    const containsCommand = (value) =>
      typeof value === "string"
        ? value.trimStart().startsWith("!")
        : Array.isArray(value)
          ? value.some(containsCommand)
          : value && typeof value === "object"
            ? Object.values(value).some(containsCommand)
            : false;
    for (const name of ["models.json", "auth.json"]) {
      let raw;
      try {
        raw = await fs.readFile(path.join(info.agentDir, name), "utf8");
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(name + " 格式无效，请修复后再使用规划模式。");
      }
      if (containsCommand(parsed))
        throw new Error(
          "规划模式不能使用命令生成的认证值。请在此环境改用普通 API Key 或 OAuth：" +
            name,
        );
    }
    return { safe: true };
  }

  if (req.action === "project.inspect") {
    const real = await fs.realpath(a.path);
    if (!(await fs.stat(real)).isDirectory())
      throw new Error("请选择项目目录。");
    let branch = "",
      gitRoot = "",
      dirty = false;
    try {
      gitRoot = (await git(real, ["rev-parse", "--show-toplevel"])).trim();
      branch = (await git(real, ["branch", "--show-current"])).trim();
      dirty = !!(await git(real, ["status", "--porcelain"])).trim();
    } catch {}
    return { path: real, gitRoot, branch, dirty };
  }
  if (req.action.startsWith("file.")) {
    const file = await within(cwd, a.path || ".");
    if (req.action === "file.list") {
      const entries = await fs.readdir(file, { withFileTypes: true });
      return entries
        .filter((e) => ![".git", "node_modules", "target"].includes(e.name))
        .map((e) => ({
          name: e.name,
          directory: e.isDirectory(),
          path: path.relative(cwd, path.join(file, e.name)),
        }))
        .sort(
          (x, y) =>
            Number(y.directory) - Number(x.directory) ||
            x.name.localeCompare(y.name),
        );
    }
    if (req.action === "file.read") {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE)
        throw new Error("文件超过 8 MB，请使用外部编辑器。");
      const data = await fs.readFile(file);
      if (data.includes(0)) throw new Error("二进制文件无法编辑。");
      return { text: data.toString("utf8"), revision: hash(data) };
    }
    if (req.action === "file.write") {
      const data = await fs.readFile(file);
      if (hash(data) !== a.revision)
        throw new Error("文件已在外部修改，请重新加载后保存。");
      if (Buffer.byteLength(a.text) > MAX_FILE) throw new Error("文件过大。");
      const tmp = file + ".pi-desktop-" + crypto.randomUUID();
      await fs.writeFile(tmp, a.text, { mode: (await fs.stat(file)).mode });
      await fs.rename(tmp, file);
      return { revision: hash(a.text) };
    }
  }
  if (req.action.startsWith("git.")) {
    if (req.action === "git.status") {
      const files = parseStatus(
        await git(cwd, ["status", "--porcelain=v1", "-z"]),
      );
      const branch = (await git(cwd, ["branch", "--show-current"])).trim();
      const branches = (await git(cwd, ["branch", "--format=%(refname:short)"]))
        .trim()
        .split("\n")
        .filter(Boolean);
      const log = (await git(cwd, ["log", "-15", "--format=%H%x09%s"]))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((r) => {
          const [id, ...subject] = r.split("\t");
          return { id, subject: subject.join("\t") };
        });
      return { files, branch, branches, log };
    }
    if (req.action === "git.diff") {
      const file = await within(cwd, a.path);
      const rel = path.relative(cwd, file);
      let before = "";
      try {
        before = await git(cwd, [
          "show",
          `${a.staged ? "HEAD:" : ":"}${(a.staged && a.original ? path.relative(cwd, await within(cwd, a.original)) : rel).replaceAll("\\", "/")}`,
        ]);
      } catch {}
      let after = "";
      if (a.staged) {
        try {
          after = await git(cwd, ["show", ":" + rel.replaceAll("\\", "/")]);
        } catch {}
      } else {
        try {
          after = (await fs.readFile(file, "utf8")).slice(0, MAX_FILE);
        } catch {}
      }
      return { before, after };
    }
    if (req.action === "git.stage" || req.action === "git.unstage") {
      const files = await Promise.all(a.paths.map((p) => within(cwd, p)));
      return git(cwd, [
        ...(req.action === "git.stage" ? ["add"] : ["restore", "--staged"]),
        "--",
        ...files.map((f) => path.relative(cwd, f)),
      ]);
    }
    if (req.action === "git.commit") {
      if (!a.message?.trim()) throw new Error("请输入提交说明。");
      return git(cwd, ["commit", "-m", a.message]);
    }
    if (req.action === "git.checkout") {
      if (!/^[\w./-]+$/.test(a.branch) || a.branch.startsWith("-"))
        throw new Error("分支名无效。");
      if ((await git(cwd, ["status", "--porcelain"])).trim())
        throw new Error("工作区有未提交修改，请先提交。");
      return git(cwd, ["switch", a.branch]);
    }
    if (req.action === "git.worktree") {
      const branch = "codex/" + a.id;
      const dir = path.join(
        path.dirname(cwd),
        ".pi-desktop-worktrees",
        path.basename(cwd) + "-" + a.id,
      );
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await git(cwd, ["worktree", "add", "-b", branch, dir, "HEAD"]);
      return { cwd: dir, branch };
    }
    if (req.action === "git.cherryPick") {
      if (!/^[a-f0-9]{7,40}$/i.test(a.commit))
        throw new Error("提交 ID 无效。");
      if ((await git(cwd, ["status", "--porcelain"])).trim())
        throw new Error("目标目录有未提交修改。");
      if (a.targetBranch) {
        if (a.targetBranch.startsWith("-")) throw new Error("分支名无效");
        await git(cwd, ["switch", a.targetBranch]);
      }
      try {
        return {
          output: await git(cwd, ["cherry-pick", a.commit]),
          conflict: false,
        };
      } catch (e) {
        return {
          output: e.message,
          conflict: !!(
            await git(cwd, ["diff", "--name-only", "--diff-filter=U"])
          ).trim(),
        };
      }
    }
    if (req.action === "git.cherryContinue")
      return git(cwd, ["-c", "core.editor=true", "cherry-pick", "--continue"]);
    if (req.action === "git.cherryAbort")
      return git(cwd, ["cherry-pick", "--abort"]);
    if (req.action === "git.worktreeRemove") {
      const real = await fs.realpath(cwd);
      if (!real.includes(path.sep + ".pi-desktop-worktrees" + path.sep))
        throw new Error("只能移除应用创建的 worktree。");
      if ((await git(real, ["status", "--porcelain"])).trim())
        throw new Error("worktree 有未提交修改，不能移除。");
      const target = await fs.realpath(a.root);
      const unmerged = (
        await git(real, ["cherry", a.targetBranch || "main", "HEAD"])
      )
        .split("\n")
        .some((line) => line.startsWith("+"));
      if (unmerged) throw new Error("存在未合入目标分支的提交，不能移除。");
      await git(target, ["worktree", "remove", real]);
      return true;
    }
  }
  if (!info.ready) throw new Error(info.error);
  if (req.action.startsWith("session.")) {
    const { SessionManager } = await sdk(info);
    if (req.action === "session.list")
      return (await SessionManager.list(cwd)).map((s) => ({
        id: s.id,
        file: s.path,
        cwd: s.cwd,
        name: s.name || s.firstMessage || "未命名会话",
        updated: new Date(s.modified).getTime(),
        messages: s.messageCount,
      }));
    if (req.action === "session.create") {
      const m = SessionManager.create(cwd);
      m.appendSessionInfo(a.name || "新任务");
      return sessionInfo(m);
    }
    const manager = SessionManager.open(a.file);
    if (req.action === "session.history") {
      const context = manager.buildSessionContext();
      return {
        messages: context.messages,
        entries: manager
          .getBranch()
          .filter((e) => e.type === "message" && e.message.role === "user")
          .map((e) => ({
            id: e.id,
            text:
              typeof e.message.content === "string"
                ? e.message.content
                : e.message.content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n"),
          })),
        name: manager.getSessionName(),
      };
    }
    if (req.action === "session.rename") {
      manager.appendSessionInfo(a.name);
      return true;
    }
    if (req.action === "session.fork") {
      let branched = manager;
      if (a.entryId) {
        const entry = manager.getEntry(a.entryId);
        if (!entry || entry.type !== "message" || entry.message.role !== "user")
          throw new Error("请选择有效的用户消息。");
        if (entry.parentId) {
          manager.createBranchedSession(entry.parentId);
          await sessionInfo(manager);
        } else {
          branched = SessionManager.create(manager.getCwd());
          branched.appendSessionInfo("会话 · 分支");
          await sessionInfo(branched);
        }
      }
      const m = SessionManager.forkFrom(branched.getSessionFile(), cwd);
      m.appendSessionInfo((manager.getSessionName() || "会话") + " · 分支");
      return sessionInfo(m);
    }
  }
  if (req.action === "config.read")
    return readConfig(await configPath(info, cwd, a.scope, a.name));
  if (req.action === "config.save")
    return saveConfig(
      await configPath(info, cwd, a.scope, a.name),
      a.data,
      a.revision,
    );
  if (req.action === "resource.list") return resources(info, cwd);
  if (req.action === "resource.read") {
    const bases = [
      info.agentDir,
      path.join(cwd, ".pi"),
      path.join(info.home, ".agents"),
      path.join(cwd, ".agents"),
    ];
    let file = "";
    for (const base of bases) {
      try {
        file = await within(base, a.path);
        break;
      } catch {}
    }
    if (!file || /auth(?:\.json)?$/.test(file))
      throw new Error("资源路径无效。");
    if ((await fs.stat(file)).size > MAX_FILE)
      throw new Error("资源文件超过 8 MB。");
    const text = await fs.readFile(file, "utf8");
    return { text: text.slice(0, MAX_FILE) };
  }
  if (req.action === "resource.remove") {
    for (const base of [
      info.agentDir,
      path.join(cwd, ".pi"),
      path.join(info.home, ".agents"),
      path.join(cwd, ".agents"),
    ]) {
      let file;
      try {
        file = await within(base, a.source);
      } catch {
        continue;
      }
      const rel = path.relative(base, file);
      if (
        !["skills", "extensions", "prompts"].includes(rel.split(path.sep)[0]) ||
        rel.split(path.sep).length < 2
      )
        throw new Error("只能移除技能、扩展或提示模板。");
      const backup = path.join(base, "desktop-resource-backups");
      await fs.mkdir(backup, { recursive: true });
      const destination = path.join(
        backup,
        crypto.randomUUID() + "-" + path.basename(file),
      );
      await fs.rename(file, destination);
      return { backup: destination };
    }
    throw new Error("资源不属于此用户或项目。");
  }
  if (req.action === "resource.toggle") {
    const file = await configPath(info, cwd, a.scope, "settings.json");
    const current = await readConfig(file);
    const key = a.kind;
    if (!["skills", "extensions", "prompts"].includes(key))
      throw new Error("资源类型无效");
    const values = current.data[key] || [];
    const token = "-" + a.source;
    current.data[key] = a.enabled
      ? values.filter((v) => v !== token)
      : [...values.filter((v) => v !== token), token];
    return saveConfig(file, current.data, current.revision);
  }
  if (req.action === "package.install" || req.action === "package.remove") {
    if(typeof a.source==='object')a.source=a.source?.source;
    if (!a.source || a.source.startsWith("-"))
      throw new Error("请输入包来源。");
    return command(
      info.node,
      [
        info.pi,
        req.action === "package.install" ? "install" : "remove",
        a.source,
        ...(a.scope === "project" ? ["--local", "--approve"] : []),
      ],
      cwd,
    );
  }
  if (["mcp.check", "mcp.login", "mcp.logout"].includes(req.action)) {
    const { ProjectTrustStore } = await import(
      pathToFileURL(path.join(info.packageDir, "dist/core/trust-manager.js"))
        .href
    );
    new ProjectTrustStore(info.agentDir).set(cwd, true);
    const { runMcpCommand } = await import(
      pathToFileURL(path.join(info.packageDir, "dist/extensions/mcp/cli.js"))
        .href
    );
    const logs = [],
      errors = [];
    const args =
      req.action === "mcp.check"
        ? ["list", "--json"]
        : [req.action === "mcp.login" ? "login" : "logout", a.provider];
    if (args[1] !== "--json" && (!a.provider || a.provider.startsWith("-")))
      throw new Error("请输入 MCP 服务名称。");
    const code = await runMcpCommand(args, {
      cwd,
      agentDir: info.agentDir,
      log: (line) => {
        logs.push(line);
        if (req.action !== "mcp.check")
          emit({ type: "auth_notify", event: { message: line } });
      },
      error: (line) => errors.push(line),
      openUrl: (url) =>
        emit({
          type: "auth_notify",
          event: { url, message: "在浏览器中完成 MCP 认证" },
        }),
    });
    if (req.action === "mcp.check") return JSON.parse(logs.join("\n"));
    if (code) throw new Error(errors.join("\n") || "MCP 操作失败");
    return { success: true };
  }
  if (req.action === "auth.list") {
    const { ModelRuntime } = await sdk(info);
    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    return runtime.getProviders().map((p) => ({
      id: p.id,
      name: p.name || p.id,
      configured: runtime.hasConfiguredAuth(p.id),
      methods: Object.keys(p.auth || {}),
    }));
  }
  if (req.action === "auth.login") {
    const { ModelRuntime } = await sdk(info);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    await runtime.login(
      a.provider,
      a.type === "api-key" ? "api_key" : a.type || "api_key",
      {
        prompt: async (p) => a.key || (await ask(p)),
        notify: (e) => emit({ type: "auth_notify", event: e }),
      },
      { agentName: "Pi Desktop" },
    );
    return { success: true };
  }
  if (req.action === "auth.logout") {
    const { ModelRuntime } = await sdk(info);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    await runtime.logout(a.provider);
    return { success: true };
  }
  throw new Error("未知操作：" + req.action);
}

export function serve() {
  let buffer = "",
    started = false,
    pending = new Map();
  const send = (v) => process.stdout.write(JSON.stringify(v) + "\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        send({ ok: false, error: "无效 JSON" });
        continue;
      }
      if (started) {
        const resolve = pending.get(req.id);
        if (resolve) {
          pending.delete(req.id);
          resolve(req.value);
        }
        continue;
      }
      started = true;
      dispatch(
        req,
        send,
        (p) =>
          new Promise((resolve) => {
            const id = crypto.randomUUID();
            pending.set(id, resolve);
            send({ type: "auth_prompt", id, prompt: p });
          }),
      )
        .then((data) => {
          send({ ok: true, data });
          process.exit(0);
        })
        .catch((e) => {
          send({ ok: false, error: e.message });
          process.exit(1);
        });
    }
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  serve();
