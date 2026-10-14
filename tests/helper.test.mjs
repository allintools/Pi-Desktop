import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  within,
  readConfig,
  saveConfig,
  hash,
  parseStatus,
  dispatch,
  command,
  discover,
} from "../bridge/helper.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-tests-"));
const cwd = path.join(root, "中文 项目");
await fs.mkdir(cwd);
test("reject traversal and symlink escapes, allow spaces and Unicode", async () => {
  await fs.writeFile(path.join(cwd, "测试.txt"), "hello");
  assert.equal(await within(cwd, "测试.txt"), path.join(cwd, "测试.txt"));
  await assert.rejects(within(cwd, "../outside"), /超出/);
  const external = path.join(root, "outside");
  await fs.mkdir(external);
  await fs.symlink(
    external,
    path.join(cwd, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(within(cwd, "linked/new.txt"), /超出/);
});
test("file revisions prevent overwriting external changes", async () => {
  const read = await dispatch({
    action: "file.read",
    args: { cwd, path: "测试.txt" },
  });
  await fs.writeFile(path.join(cwd, "测试.txt"), "external");
  await assert.rejects(
    dispatch({
      action: "file.write",
      args: {
        cwd,
        path: "测试.txt",
        text: "overwrite",
        revision: read.revision,
      },
    }),
    /外部修改/,
  );
  const result = await dispatch({
    action: "file.write",
    args: {
      cwd,
      path: "测试.txt",
      text: "changed",
      revision: hash("external"),
    },
  });
  assert.equal(result.revision, hash("changed"));
});
test("atomic configuration preserves fields and detects stale revision", async () => {
  const file = path.join(root, "settings.json");
  await fs.writeFile(
    file,
    JSON.stringify({ unknown: { keep: true }, defaultModel: "a" }),
  );
  const read = await readConfig(file);
  const saved = await saveConfig(file, { defaultModel: "b" }, read.revision);
  assert.deepEqual(saved.data.unknown, { keep: true });
  assert.equal(saved.data.defaultModel, "b");
  await assert.rejects(
    saveConfig(file, { defaultModel: "c" }, read.revision),
    /其他程序/,
  );
});
test("porcelain NUL records retain renames and whitespace", () => {
  assert.deepEqual(parseStatus("R  new name\0old name\0?? 新 文件\0"), [
    { status: "R ", path: "new name", original: "old name" },
    { status: "??", path: "新 文件", original: undefined },
  ]);
});
test("worktree leaves dirty source unchanged and cherry-pick transfers committed change", async () => {
  await command("git", ["init", "-b", "main"], cwd);
  await command(
    "git",
    ["config", "user.email", "fixture@example.invalid"],
    cwd,
  );
  await command("git", ["config", "user.name", "Fixture"], cwd);
  await command("git", ["add", "."], cwd);
  await command("git", ["commit", "-m", "initial"], cwd);
  await fs.writeFile(path.join(cwd, "测试.txt"), "dirty source");
  const tree = await dispatch({
    action: "git.worktree",
    args: { cwd, id: "fixture" },
  });
  assert.equal(
    await fs.readFile(path.join(cwd, "测试.txt"), "utf8"),
    "dirty source",
  );
  assert.equal(
    await fs.readFile(path.join(tree.cwd, "测试.txt"), "utf8"),
    "changed",
  );
  await fs.writeFile(path.join(tree.cwd, "feature.txt"), "feature");
  await dispatch({
    action: "git.stage",
    args: { cwd: tree.cwd, paths: ["feature.txt"] },
  });
  await dispatch({
    action: "git.commit",
    args: { cwd: tree.cwd, message: "feature" },
  });
  const git = await dispatch({ action: "git.status", args: { cwd: tree.cwd } });
  assert.equal(git.branch, "codex/fixture");
  assert.equal(git.files.length, 0);
  await assert.rejects(
    dispatch({
      action: "git.cherryPick",
      args: { cwd, commit: git.log[0].id },
    }),
    /未提交/,
  );
  await fs.writeFile(path.join(cwd, "测试.txt"), "changed");
  const result = await dispatch({
    action: "git.cherryPick",
    args: { cwd, commit: git.log[0].id },
  });
  assert.equal(result.conflict, false);
  assert.equal(
    await fs.readFile(path.join(cwd, "feature.txt"), "utf8"),
    "feature",
  );
  await dispatch({
    action: "git.worktreeRemove",
    args: { cwd: tree.cwd, root: cwd, targetBranch: "main" },
  });
});
test("real pi SDK creates, lists and reads persistent sessions without credentials", async () => {
  const run = (req) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["bridge/helper.mjs"], {
        cwd: process.cwd(),
        windowsHide: true,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: path.join(root, "agent"),
          PI_OFFLINE: "1",
        },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", () => {
        try {
          const v = JSON.parse(out.trim().split("\n").at(-1));
          v.ok ? resolve(v.data) : reject(Error(v.error));
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(JSON.stringify(req) + "\n");
    });
  const s = await run({
    action: "session.create",
    args: { cwd, name: "SDK fixture" },
  });
  assert.ok((await fs.stat(s.file)).size > 0);
  const list = await run({ action: "session.list", args: { cwd } });
  assert.equal(list[0].name, "SDK fixture");
  const history = await run({
    action: "session.history",
    args: { file: s.file, cwd },
  });
  assert.equal(history.messages.length, 0);
  const fork = await run({
    action: "session.fork",
    args: { file: s.file, cwd },
  });
  assert.notEqual(fork.file, s.file);
  assert.ok((await fs.stat(fork.file)).size > 0);
});
test("installed runtime baseline is detected", async () => {
  const info = await discover();
  assert.equal(info.ready, true);
  assert.ok(info.pi.endsWith(".js"));
  assert.ok(info.git);
});

test("project skills can be disabled and removed with a recoverable backup", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-resources-"));
  const skill = path.join(project, ".agents", "skills", "fixture");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "# Fixture skill");
  const resources = await dispatch({
    action: "resource.list",
    args: { cwd: project },
  });
  const entry = resources.find((r) => r.source === skill);
  assert.ok(entry && entry.kind === "skills");
  await dispatch({
    action: "resource.toggle",
    args: {
      cwd: project,
      kind: "skills",
      scope: "project",
      source: skill,
      enabled: false,
    },
  });
  assert.equal(
    (await dispatch({ action: "resource.list", args: { cwd: project } })).find(
      (r) => r.source === skill,
    ).enabled,
    false,
  );
  const removed = await dispatch({
    action: "resource.remove",
    args: { cwd: project, source: skill },
  });
  assert.equal(
    await fs.readFile(path.join(removed.backup, "SKILL.md"), "utf8"),
    "# Fixture skill",
  );
  await assert.rejects(fs.access(skill));
});
