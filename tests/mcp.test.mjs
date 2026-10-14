import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { discover } from "../bridge/helper.mjs";

const helper = path.resolve("bridge/helper.mjs");
function run(action, args, agent, target, onEvent = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agent },
      windowsHide: true,
    });
    let buffer = "",
      error = "";
    child.stdin.write(JSON.stringify({ target, action, args }) + "\n");
    child.stderr.on("data", (d) => (error += d));
    child.stdout.on("data", (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const v = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (v.ok !== undefined) {
          v.ok ? resolve(v.data) : reject(new Error(v.error));
        } else onEvent(v, child);
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code) reject(new Error(error || "helper exited"));
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("helper timeout"));
    }, 30000);
    child.on("exit", () => clearTimeout(timer));
  });
}
test('planning rejects command-generated credentials before starting the agent',async()=>{
 const info=await discover(),root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-plan-'));await fs.writeFile(path.join(root,'models.json'),JSON.stringify({providers:{fixture:{apiKey:'!node -e "process.exit(99)"'}}}));
 await assert.rejects(run('plan.check',{cwd:root},root,{pi:info.pi}),/规划模式不能使用命令生成/);
 await fs.writeFile(path.join(root,'models.json'),JSON.stringify({providers:{fixture:{apiKey:'fixture-only'}}}));assert.equal((await run('plan.check',{cwd:root},root,{pi:info.pi})).safe,true);
});
test("real SDK API-key authentication stays in the target pi directory", async () => {
  const info = await discover();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-auth-"));
  const target = { pi: info.pi };
  const before = await run("auth.list", {}, root, target);
  assert.ok(before.some((p) => p.id === "openai"));
  await run(
    "auth.login",
    { provider: "openai", type: "api-key" },
    root,
    target,
    (e, child) => {
      if (e.type === "auth_prompt")
        child.stdin.write(
          JSON.stringify({ id: e.id, value: "fixture-key-no-network" }) + "\n",
        );
    },
  );
  assert.ok(
    (await run("auth.list", {}, root, target)).find((p) => p.id === "openai")
      .configured,
  );
  await run("auth.logout", { provider: "openai" }, root, target);
  assert.equal(
    (await run("auth.list", {}, root, target)).find((p) => p.id === "openai")
      .configured,
    false,
  );
});
test("MCP checks stdio and HTTP, completes SDK OAuth callback and logs out", async () => {
  const info = await discover(),
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mcp-"));
  const cwd = path.join(root, "project"),
    agent = path.join(root, "agent");
  await fs.mkdir(cwd);
  await fs.mkdir(agent);
  const answer = (m) => ({
    jsonrpc: "2.0",
    id: m.id,
    result:
      m.method === "initialize"
        ? {
            protocolVersion: m.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : m.method === "tools/list"
          ? {
              tools: [
                {
                  name: "fixture_read",
                  description: "fixture",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : {},
  });
  const stdio = path.join(root, "stdio.mjs");
  await fs.writeFile(
    stdio,
    `import readline from 'node:readline';const answer=${answer.toString()};for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id!==undefined)console.log(JSON.stringify(answer(m)))}`,
  );
  let origin;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    let body = "";
    for await (const d of req) body += d;
    const json = (data) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource")
      return json({
        resource: origin + "/mcp",
        authorization_servers: [origin],
        scopes_supported: ["read"],
      });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
      return json({
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        registration_endpoint: origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register")
      return json({ ...JSON.parse(body), client_id: "fixture-client" });
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", "fixture-code");
      redirect.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: redirect.href });
      return res.end();
    }
    if (url.pathname === "/token")
      return json({
        access_token: "fixture-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "fixture-refresh",
        scope: "read",
      });
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer fixture-token") {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        });
        return res.end();
      }
      if (req.method === "GET") {
        res.writeHead(405);
        return res.end();
      }
      if (!body) {
        res.writeHead(200);
        return res.end();
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      return json(answer(message));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await fs.writeFile(
      path.join(agent, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          stdio: { command: process.execPath, args: [stdio] },
          http: { url: origin + "/mcp" },
        },
      }),
    );
    const target = { pi: info.pi };
    const checked = await run("mcp.check", { cwd }, agent, target);
    assert.equal(
      checked.servers.find((s) => s.name === "stdio").state,
      "connected",
    );
    assert.equal(
      checked.servers.find((s) => s.name === "http").state,
      "needs-auth",
    );
    let authFlow;
    await run("mcp.login", { cwd, provider: "http" }, agent, target, (e) => {
      if (e.event?.url) authFlow = fetch(e.event.url).then((r) => r.text());
    });
    await authFlow;
    const ready = await run("mcp.check", { cwd }, agent, target);
    assert.equal(
      ready.servers.find((s) => s.name === "http").state,
      "connected",
    );
    assert.ok(await fs.stat(path.join(agent, "mcp-auth.json")));
    await run("mcp.logout", { cwd, provider: "http" }, agent, target);
    assert.equal(
      (await run("mcp.check", { cwd }, agent, target)).servers.find(
        (s) => s.name === "http",
      ).state,
      "needs-auth",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
