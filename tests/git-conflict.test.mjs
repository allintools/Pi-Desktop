import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatch, command } from "../bridge/helper.mjs";
test("cherry-pick conflict can abort, resolve and continue without losing work", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-conflict-"));
  const git = (args) => command("git", args, cwd);
  await git(["init", "-b", "main"]);
  await git(["config", "core.autocrlf", "false"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@localhost"]);
  await fs.writeFile(path.join(cwd, "file.txt"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  const tree = await dispatch({
    action: "git.worktree",
    args: { cwd, id: "conflict-fixture" },
  });
  await fs.writeFile(path.join(tree.cwd, "file.txt"), "feature\n");
  await dispatch({
    action: "git.stage",
    args: { cwd: tree.cwd, paths: ["file.txt"] },
  });
  await dispatch({
    action: "git.commit",
    args: { cwd: tree.cwd, message: "feature" },
  });
  const commit = (
    await dispatch({ action: "git.status", args: { cwd: tree.cwd } })
  ).log[0].id;
  await fs.writeFile(path.join(cwd, "file.txt"), "target\n");
  await git(["add", "."]);
  await git(["commit", "-m", "target"]);
  await assert.rejects(
    dispatch({
      action: "git.worktreeRemove",
      args: { cwd: tree.cwd, root: cwd, targetBranch: "main" },
    }),
    /未合入/,
  );
  const pick = () =>
    dispatch({
      action: "git.cherryPick",
      args: { cwd, commit, targetBranch: "main" },
    });
  assert.equal((await pick()).conflict, true);
  await dispatch({ action: "git.cherryAbort", args: { cwd } });
  assert.equal(
    await fs.readFile(path.join(cwd, "file.txt"), "utf8"),
    "target\n",
  );
  assert.equal((await pick()).conflict, true);
  await fs.writeFile(path.join(cwd, "file.txt"), "resolved\n");
  await dispatch({ action: "git.stage", args: { cwd, paths: ["file.txt"] } });
  await dispatch({ action: "git.cherryContinue", args: { cwd } });
  assert.equal(
    (await dispatch({ action: "git.status", args: { cwd } })).files.length,
    0,
  );
  assert.equal(
    await fs.readFile(path.join(cwd, "file.txt"), "utf8"),
    "resolved\n",
  );
});
