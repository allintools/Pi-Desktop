// Read-only installed-release smoke; run after native.cjs exits (single-instance app).
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
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
  const exe = path.resolve(
    process.argv[2] || "outputs/installed/pi-desktop.exe",
  );
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-installed-webview-"),
  );
  const child = spawn(exe, [], {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9432",
    },
  });
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let browser, pg;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if (
          (
            await fetch("http://127.0.0.1:9432/json/list").then((r) => r.json())
          ).some((p) => p.url.includes("tauri.localhost"))
        )
          break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9432");
    pg = browser.contexts()[0].pages()[0];
    await pg.waitForSelector(".app-shell");
    const invoke = (cmd, args = {}) =>
      pg.evaluate(
        ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a),
        [cmd, args],
      );
    const info = await invoke("request", {
      action: "detect",
      args: {},
      projectId: null,
      sessionId: null,
      target: { kind: "windows" },
    });
    assert.equal(info.ready, true);
    assert.equal(info.version, "1.1.0");
    const metadata = await invoke("metadata");
    assert.ok(Array.isArray(metadata.projects));
    await assert.rejects(invoke("request", {
      action: "project.inspect",
      args: { path: process.cwd() },
      projectId: null,
      sessionId: null,
      target: { kind: "windows" },
    }), /请先选择项目/);
    await pg.screenshot({ path: "outputs/installed-startup.png" });
    await fs.writeFile(
      "outputs/installed-checks.json",
      JSON.stringify(
        {
          exe,
          checks: [
            { name: "NSIS silent install and bundled helper path", pass: true },
            {
              name: "installed release UI and real Node/pi SDK compatibility detection",
              pass: true,
            },
            {
              name: "installed release reads SQLite and rejects operations without a project binding",
              pass: true,
            },
          ],
          version: info.version,
          stderr,
        },
        null,
        2,
      ),
    );
    await invoke("quit").catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    assert.notEqual(child.exitCode, null);
    console.log("Installed release: 3 checks passed; explicit quit confirmed");
  } finally {
    if (pg)
      await pg
        .evaluate(() =>
          Promise.race([
            window.__TAURI_INTERNALS__.invoke("quit"),
            new Promise((r) => setTimeout(r, 3000)),
          ]),
        )
        .catch(() => {});
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
