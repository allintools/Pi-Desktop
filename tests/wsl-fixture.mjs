import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = await fs.mkdtemp("/tmp/pi-desktop-wsl-"),
  cwd = path.join(root, "中文 project"),
  agent = path.join(root, "agent");
await fs.mkdir(cwd);
await fs.mkdir(agent);
await fs.writeFile(path.join(cwd, "sample.txt"), "WSL fixture");
const server = http.createServer(async (req, res) => {
  for await (const d of req) {
  }
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
  res.write(frame({ role: "assistant", content: "WSL pi fixture ✓ 中文" }));
  res.write(frame({}, "stop"));
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await fs.writeFile(
  path.join(agent, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          {
            id: "fixture",
            name: "WSL local validation",
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
const wrapper = path.join(root, "node-test");
await fs.writeFile(
  wrapper,
  `#!/bin/sh\nexport PI_CODING_AGENT_DIR='${agent}'\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
  { mode: 0o700 },
);
for (const args of [
  ["init", "-b", "main"],
  ["config", "user.name", "Pi Validation"],
  ["config", "user.email", "fixture@localhost"],
  ["add", "."],
  ["commit", "-m", "fixture"],
])
  execFileSync("git", args, { cwd, stdio: "ignore" });
const info = {
  root,
  cwd,
  agent,
  target: {
    kind: "wsl",
    distro: process.env.WSL_DISTRO_NAME || "Ubuntu",
    user: os.userInfo().username,
    node: wrapper,
    pi: process.env.PI_DESKTOP_TEST_PI || "",
  },
};
await fs.writeFile(
  fileURLToPath(new URL("../outputs/wsl.json", import.meta.url)),
  JSON.stringify(info),
);
console.log("WSL_FIXTURE_READY " + root);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
