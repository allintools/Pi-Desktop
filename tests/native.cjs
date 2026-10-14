// Native integration test. Uses real Tauri, pi, Git, ConPTY and a local model fixture.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http"),
  { spawn } = require("node:child_process"),
  assert = require("node:assert/strict");
const pw = process.env.PLAYWRIGHT_MODULE
  ? require(process.env.PLAYWRIGHT_MODULE)
  : (() => {
      try {
        return require("playwright");
      } catch {
        return require(
          path.join(
            os.homedir(),
            ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js",
          ),
        );
      }
    })();
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-native-"));
  const cwd = path.join(root, "中文 project"),
    agent = path.join(root, "agent");
  await fs.mkdir(cwd);
  await fs.mkdir(agent);
  await fs.writeFile(path.join(cwd, "sample.txt"), "native fixture");
  let modelCalls = 0,
    receivedCalls = 0;
  const model = http.createServer(async (req, res) => {
    receivedCalls++;
    let body = "";
    for await (const d of req) body += d;
    const input = JSON.parse(body);
    const last = input.messages.findLast((m) => m.role === "user")?.content;
    await new Promise((r) =>
      setTimeout(r, String(last).includes("queue") ? 1500 : 50),
    );
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish = null) =>
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n";
    if (JSON.stringify(last).includes("workflow fixture")) {
      const completed = input.messages.filter((m) => m.role === "tool").length;
      if (completed < 2) {
        const tool =
          completed === 0
            ? {
                name: "write",
                arguments: JSON.stringify({
                  path: "add.cjs",
                  content: "exports.add=(a,b)=>a+b;\n",
                }),
              }
            : {
                name: "bash",
                arguments: JSON.stringify({
                  command: "node --test add.test.cjs",
                }),
              };
        res.write(
          frame({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "workflow-" + completed,
                type: "function",
                function: tool,
              },
            ],
          }),
        );
        res.write(frame({}, "tool_calls"));
        res.end("data: [DONE]\n\n");
        modelCalls++;
        return;
      }
    }
    res.write(
      frame({ role: "assistant", content: "Native pi fixture ✓ 中文" }),
    );
    res.write(frame({}, "stop"));
    res.end("data: [DONE]\n\n");
    modelCalls++;
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  await fs.writeFile(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "fixture",
              name: "Local validation fixture",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture",
      autoRetry: { enabled: false },
    }),
  );
  const output = path.resolve("outputs");
  await fs.mkdir(output, { recursive: true });
  const checks = [];
  checks.push = (...items) => {
    items.forEach((i) => console.log(i.name));
    return Array.prototype.push.apply(checks, items);
  };
  const exe = path.resolve("src-tauri/target/debug/pi-desktop.exe");
  let child = spawn(exe, [], {
    windowsHide: true,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agent,
      PI_DESKTOP_DATA_DIR: path.join(root, "desktop"),
      WEBVIEW2_USER_DATA_FOLDER: path.join(root, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9431",
    },
  });
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
    console.error(String(d));
  });
  child.on("error", (e) => (stderr += e.message));
  let browser, pg;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const list = await fetch("http://127.0.0.1:9431/json/list").then((r) =>
          r.json(),
        );
        if (list.some((p) => p.url.includes("tauri.localhost"))) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9431");
    pg = browser.contexts()[0].pages()[0];
    await pg.waitForSelector(".app-shell");
    const invoke = (command, args = {}) =>
      pg.evaluate(
        async ({ command, args }) =>
          Promise.race([
            window.__TAURI_INTERNALS__.invoke(command, args),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(command + " exceeded 45s")),
                45000,
              ),
            ),
          ]),
        { command, args },
      );
    await pg.evaluate(() => {
      window.fixtureEvents = [];
      window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
        event: "desktop-events",
        target: { kind: "Any" },
        handler: window.__TAURI_INTERNALS__.transformCallback((e) =>
          window.fixtureEvents.push(...e.payload),
        ),
      });
    });
    await pg.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
        event: "terminal-data",
        target: { kind: "Any" },
        handler: window.__TAURI_INTERNALS__.transformCallback((e) => {
          if (atob(e.payload.data).includes("\x1b[6n"))
            void window.__TAURI_INTERNALS__.invoke("terminal_write", {
              id: e.payload.id,
              data: "\x1b[1;1R",
            });
        }),
      }),
    );
    const project = await invoke("project_save", {
      value: {
        id: "",
        name: "原生验证项目",
        path: cwd,
        target: { kind: "windows" },
        trusted: true,
      },
    });
    checks.push({
      name: "canonical project + SQLite",
      pass: project.path === cwd,
    });
    const detected = await invoke("request", {
      action: "detect",
      projectId: project.id,
      sessionId: null,
      target: null,
      args: {},
    });
    assert.equal(detected.ready, true);
    checks.push({ name: "installed pi 1.1.0 detected", pass: true });
    const create = (name) =>
      invoke("new_session", {
        projectId: project.id,
        name,
        isolated: false,
        mode: "plan",
        existing: null,
        fork: null,
        entryId: null,
      });
    const session = await create("规划模式验证");
    const state = await invoke("runtime_open", { id: session.id });
    assert.equal(state.state.model.id, "fixture");
    checks.push({ name: "real pi RPC startup", pass: true });
    const rpc = (id, command) => invoke("rpc", { id, command });
    await assert.rejects(
      rpc(session.id, { type: "bash", command: "echo forbidden" }),
    );
    await assert.rejects(
      rpc(session.id, { type: "prompt", message: "/reload" }),
    );
    checks.push({
      name: "plan mode rejects RPC shell + slash commands",
      pass: true,
    });
    await rpc(session.id, { type: "prompt", message: "native fixture" });
    await pg.waitForFunction(
      (id) =>
        window.fixtureEvents.some(
          (e) => e.sessionId === id && e.payload.type === "agent_settled",
        ),
      session.id,
    );
    const messages = await rpc(session.id, { type: "get_messages" });
    assert.ok(JSON.stringify(messages).includes("Native pi fixture"));
    checks.push({
      name: "streamed model fixture + settled + history",
      pass: true,
    });
    const read = await invoke("request", {
      action: "file.read",
      sessionId: session.id,
      projectId: null,
      target: null,
      args: { path: "sample.txt" },
    });
    assert.equal(read.text, "native fixture");
    await invoke("request", {
      action: "file.write",
      sessionId: session.id,
      projectId: null,
      target: null,
      args: {
        path: "sample.txt",
        text: "saved from native",
        revision: read.revision,
      },
    });
    checks.push({ name: "native file read + conflict-safe write", pass: true });
    const five = await Promise.all(
      Array.from({ length: 5 }, (_, i) => create("并行 " + i)),
    );
    await Promise.all(five.map((s) => invoke("runtime_open", { id: s.id })));
    const responses = await Promise.all(
      five.map((s) => rpc(s.id, { type: "prompt", message: "queue fixture" })),
    );
    assert.ok(responses.some((r) => r.disposition === "queued"));
    await pg.waitForFunction(
      (ids) =>
        ids.every((id) =>
          window.fixtureEvents.some(
            (e) => e.sessionId === id && e.payload.type === "agent_settled",
          ),
        ),
      five.map((s) => s.id),
    );
    checks.push({
      name: "4 parallel tasks + fifth queued and completed",
      pass: true,
    });
    const terminal = await invoke("terminal_open", { sessionId: session.id });
    await invoke("terminal_resize", { id: terminal, cols: 100, rows: 24 });
    await invoke("terminal_write", {
      id: terminal,
      data: "Write-Output 'CONPTY_CHECK'\r",
    });
    await invoke("terminal_close", { id: terminal });
    checks.push({ name: "ConPTY create/write/resize/close", pass: true });
    const workflow = path.join(root, "workflow");
    await fs.mkdir(workflow);
    await fs.writeFile(
      path.join(workflow, "add.cjs"),
      "exports.add=(a,b)=>a-b;\n",
    );
    await fs.writeFile(
      path.join(workflow, "add.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');test('addition',()=>assert.equal(require('./add.cjs').add(2,3),5));",
    );
    const { execFileSync: execGit } = require("node:child_process");
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "Pi Fixture"],
      ["config", "user.email", "fixture@localhost"],
      ["add", "."],
      ["commit", "-m", "baseline"],
    ])
      execGit("git", ["-C", workflow, ...args], {
        windowsHide: true,
        stdio: "ignore",
      });
    const flowProject = await invoke("project_save", {
      value: {
        id: "",
        name: "完整流程",
        path: workflow,
        target: { kind: "windows" },
        trusted: true,
      },
    });
    const flow = await invoke("new_session", {
      projectId: flowProject.id,
      name: "写入与测试",
      isolated: true,
      mode: "execute",
      existing: null,
      fork: null,
      entryId: null,
    });
    await invoke("runtime_open", { id: flow.id });
    await rpc(flow.id, { type: "prompt", message: "workflow fixture" });
    await pg.waitForFunction(
      (id) =>
        window.fixtureEvents.some(
          (e) => e.sessionId === id && e.payload.type === "agent_settled",
        ),
      flow.id,
    );
    const toolEvents = await pg.evaluate(
      (id) =>
        window.fixtureEvents.filter(
          (e) => e.sessionId === id && e.payload.type === "tool_execution_end",
        ),
      flow.id,
    );
    assert.ok(
      toolEvents.some(
        (e) => e.payload.toolName === "bash" && !e.payload.isError,
      ),
    );
    assert.equal(
      await fs.readFile(path.join(flow.cwd, "add.cjs"), "utf8"),
      "exports.add=(a,b)=>a+b;\n",
    );
    const flowReq = (action, args = {}) =>
      invoke("request", {
        action,
        sessionId: flow.id,
        projectId: null,
        target: null,
        args,
      });
    const diff = await flowReq("git.diff", { path: "add.cjs", staged: false });
    assert.ok(diff.before.includes("a-b") && diff.after.includes("a+b"));
    await flowReq("git.stage", { paths: ["add.cjs"] });
    await flowReq("git.commit", { message: "Fix addition" });
    const head = (await flowReq("git.status")).log[0].id;
    const applied = await invoke("request", {
      action: "git.cherryPick",
      projectId: flowProject.id,
      sessionId: null,
      target: null,
      args: { commit: head, targetBranch: "main" },
    });
    assert.equal(applied.conflict, false);
    assert.ok(
      (await fs.readFile(path.join(workflow, "add.cjs"), "utf8")).includes(
        "a+b",
      ),
    );
    await invoke("runtime_close", { id: flow.id });
    await flowReq("git.worktreeRemove", { targetBranch: "main" });
    checks.push({
      name: "execute writes file, runs real tests, reviews diff, stages, commits and cherry-picks safely",
      pass: true,
    });
    await invoke("runtime_close", { id: session.id });
    await invoke("session_update", {
      id: session.id,
      patch: { mode: "execute" },
    });
    const next = await invoke("runtime_open", { id: session.id });
    assert.equal(next.state.sessionId, state.state.sessionId);
    checks.push({ name: "mode rebuild keeps pi session identity", pass: true });
    await pg.reload();
    await pg.waitForSelector(".project-name");
    await pg.getByText("规划模式验证", { exact: true }).first().click();
    await pg.waitForSelector(".composer");
    await pg.getByRole("button", { name: "文件", exact: true }).click();
    await pg.getByRole("button", { name: "sample.txt", exact: false }).click();
    await pg.waitForSelector(".monaco-editor");
    checks.push({ name: "native UI + Monaco editor", pass: true });
    await pg.screenshot({ path: path.join(output, "native-workbench.png") });
    await pg.getByRole("button", { name: "设置与外观", exact: false }).click();
    await pg.waitForSelector(".appearance-settings");
    await pg.screenshot({ path: path.join(output, "native-appearance.png") });
    const appearance = await require("./appearance.cjs")(pg, output);
    await fs.writeFile(
      path.join(output, "appearance-checks.json"),
      JSON.stringify(appearance, null, 2),
    );
    checks.push({
      name: "90 theme layouts, wallpaper, persistence, storage failure",
      pass: true,
    });
    await pg.evaluate(() => {
      window.fixtureEvents = [];
      return window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
        event: "desktop-events",
        target: { kind: "Any" },
        handler: window.__TAURI_INTERNALS__.transformCallback((e) =>
          window.fixtureEvents.push(...e.payload),
        ),
      });
    });

    await pg.getByText("规划模式验证", { exact: true }).first().click();
    await pg.getByLabel("消息输入").fill("per-session draft");
    await pg.getByText("并行 0", { exact: true }).first().click();
    await pg.getByText("规划模式验证", { exact: true }).first().click();
    assert.equal(
      await pg.getByLabel("消息输入").inputValue(),
      "per-session draft",
    );
    checks.push({
      name: "unsent draft survives session switching",
      pass: true,
    });
    await pg.getByLabel("新建任务", { exact: true }).click();
    await pg.waitForSelector("[role=dialog]");
    await pg.keyboard.press("Tab");
    assert.ok(
      await pg.evaluate(() =>
        document
          .querySelector("[role=dialog]")
          .contains(document.activeElement),
      ),
    );
    await pg.keyboard.press("Escape");
    await pg.waitForSelector("[role=dialog]", { state: "detached" });
    checks.push({ name: "dialog focus and Escape cancellation", pass: true });
    await pg.evaluate(() => {
      const key = "pi-desktop.appearance.v1",
        p = { ...JSON.parse(localStorage.getItem(key)), scale: 150 };
      localStorage.setItem(key, JSON.stringify(p));
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: JSON.stringify(p) }),
      );
    });
    await pg.setViewportSize({ width: 960, height: 680 });
    await pg.getByRole("button", { name: "返回对话", exact: true }).click();
    await pg.getByLabel("消息输入").waitFor({ state: "visible" });
    await pg.screenshot({ path: path.join(output, "native-narrow.png") });
    checks.push({
      name: "960px at 150% returns from workspace to usable composer",
      pass: true,
    });
    await pg.setViewportSize({ width: 1440, height: 900 });
    if (process.env.PI_DESKTOP_WSL_FIXTURE) {
      const fixture = JSON.parse(
        await fs.readFile(process.env.PI_DESKTOP_WSL_FIXTURE, "utf8"),
      );
      const wp = await invoke("project_save", {
        value: {
          id: "",
          name: "WSL 验证",
          path: fixture.cwd,
          target: fixture.target,
          trusted: true,
        },
      });
      const req = (action, args = {}) =>
        invoke("request", {
          action,
          projectId: wp.id,
          sessionId: null,
          target: null,
          args,
        });
      const info = await req("detect");
      assert.equal(info.ready, true);
      assert.equal(info.agentDir, fixture.agent);
      assert.notEqual(info.agentDir, agent);
      const ws = await invoke("new_session", {
        projectId: wp.id,
        name: "WSL 原生任务",
        isolated: true,
        mode: "plan",
        existing: null,
        fork: null,
        entryId: null,
      });
      assert.equal(ws.worktree, true);
      await invoke("runtime_open", { id: ws.id });
      await rpc(ws.id, { type: "prompt", message: "WSL native fixture" });
      await pg.waitForFunction(
        (id) =>
          window.fixtureEvents.some(
            (e) => e.sessionId === id && e.payload.type === "agent_settled",
          ),
        ws.id,
      );
      assert.ok(
        JSON.stringify(await rpc(ws.id, { type: "get_messages" })).includes(
          "WSL pi fixture",
        ),
      );
      const wr = await invoke("request", {
        action: "file.read",
        sessionId: ws.id,
        projectId: null,
        target: null,
        args: { path: "sample.txt" },
      });
      assert.equal(wr.text, "WSL fixture");
      const git = await invoke("request", {
        action: "git.status",
        sessionId: ws.id,
        projectId: null,
        target: null,
        args: {},
      });
      assert.ok(git.branch.startsWith("codex/"));
      const wt = await invoke("terminal_open", { sessionId: ws.id });
      await invoke("terminal_write", {
        id: wt,
        data: "echo WSL_TERMINAL_CHECK\r",
      });
      await invoke("terminal_close", { id: wt });
      await invoke("runtime_close", { id: ws.id });
      checks.push({
        name: "real WSL Node/pi RPC, Unicode path, Git worktree, files, PTY, isolated config and cleanup",
        pass: true,
      });
    }
    await invoke("plugin:window|close", { label: "main" });
    assert.equal(
      await invoke("plugin:window|is_visible", { label: "main" }),
      false,
    );
    await rpc(session.id, { type: "prompt", message: "hidden tray fixture" });
    await pg.waitForFunction(
      (id) =>
        window.fixtureEvents.some(
          (e) => e.sessionId === id && e.payload.type === "agent_settled",
        ),
      session.id,
    );
    await invoke("plugin:window|show", { label: "main" });
    checks.push({
      name: "window close hides to tray and runtime remains usable",
      pass: true,
    });
    const launchAgain = async () => {
      child = spawn(exe, [], {
        windowsHide: true,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agent,
          PI_DESKTOP_DATA_DIR: path.join(root, "desktop"),
          WEBVIEW2_USER_DATA_FOLDER: path.join(root, "webview"),
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9431",
        },
      });
      child.stdout.resume();
      child.stderr.on("data", (d) => (stderr += d));
      for (let i = 0; i < 100; i++) {
        try {
          const list = await fetch("http://127.0.0.1:9431/json/list").then(
            (r) => r.json(),
          );
          if (list.some((p) => p.url.includes("tauri.localhost"))) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9431");
      pg = browser.contexts()[0].pages()[0];
      await pg.waitForSelector(".app-shell");
    };
    await pg.evaluate(() => {
      const key = "pi-desktop.appearance.v1",
        p = {
          ...JSON.parse(localStorage.getItem(key)),
          preset: "dark",
          scale: 125,
        };
      localStorage.setItem(key, JSON.stringify(p));
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: JSON.stringify(p) }),
      );
    });
    await pg.waitForTimeout(300);
    await invoke("layout_save", {
      value: { collapsed: true, panel: false, width: 510 },
    });
    await invoke("quit").catch(() => {});
    await browser.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    await launchAgain();
    assert.deepEqual((await invoke("metadata")).layout, {
      collapsed: true,
      panel: false,
      width: 510,
    });
    await pg.waitForSelector(".sidebar-collapsed");
    await pg.getByRole("button", { name: "展开侧栏", exact: true }).click();
    assert.equal(
      await pg.evaluate(() => document.documentElement.dataset.theme),
      "dark",
    );
    assert.equal(
      await pg.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--theme-scale",
        ),
      ),
      "1.25",
    );
    checks.push({
      name: "actual native restart restores theme, SQLite projects and layout",
      pass: true,
    });
    await invoke("runtime_open", { id: session.id });
    await rpc(session.id, { type: "prompt", message: "queue crash fixture" });
    const { execFileSync } = require("node:child_process");
    const owned = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `@((Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${child.pid} -and $_.Name -eq 'node.exe' }).ProcessId) | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, encoding: "utf8" },
      ),
    );
    const ids = Array.isArray(owned) ? owned : [owned];
    child.kill();
    await browser.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    for (const pid of ids) {
      assert.throws(() => process.kill(pid, 0), "owned pi survived host crash");
    }
    const received = receivedCalls;
    await launchAgain();
    const recovered = await invoke("metadata");
    assert.equal(
      recovered.sessions.find((s) => s.id === session.id).runtimeState,
      "running",
    );
    await pg.getByText("规划模式验证", { exact: true }).first().click();
    await pg.getByText("运行中断，可继续", { exact: true }).waitFor();
    await pg.waitForTimeout(200);
    assert.equal(receivedCalls, received);
    checks.push({
      name: "host crash kills Windows children, restores interrupted history without replay",
      pass: true,
    });
    await fs.writeFile(
      path.join(output, "native-checks.json"),
      JSON.stringify({ root, modelCalls, checks, stderr }, null, 2),
    );
    console.log(JSON.stringify({ root, modelCalls, checks }, null, 2));
  } finally {
    if (pg)
      await pg
        .evaluate(() =>
          Promise.race([
            window.__TAURI_INTERNALS__.invoke("quit"),
            new Promise((r) => setTimeout(r, 5000)),
          ]),
        )
        .catch(() => {});
    if (browser) await browser.close().catch(() => {});
    child.kill();
    model.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
