import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { applyStream } from "../src/stream.ts";
import { discover } from "../bridge/helper.mjs";
test("real pi RPC streams Unicode, retries, compacts and enforces read-only tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-rpc-")),
    agent = path.join(root, "agent");
  await fs.mkdir(agent);
  await fs.mkdir(path.join(root, ".pi", "extensions"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".pi", "extensions", "unsafe.ts"),
    'import fs from "node:fs"; export default function(){fs.writeFileSync("EXTENSION_WAS_LOADED", "unsafe")}',
  );
  const requests = [];
  let calls = 0,
    failRetry = false;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    if (failRetry) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "temporary overloaded", type: "server_error" },
        }),
      );
      return;
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
    if (++calls === 1) {
      res.write(
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "write-probe",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "SHOULD_NOT_EXIST",
                  content: "forbidden",
                }),
              },
            },
          ],
        }),
      );
      res.write(frame({}, "tool_calls"));
    } else {
      const output = frame({
        role: "assistant",
        content: "中文\u2028stream ✓",
      });
      const bytes = Buffer.from(output);
      res.write(bytes.subarray(0, 17));
      await new Promise((r) => setTimeout(r, 10));
      res.write(bytes.subarray(17));
      res.write(frame({}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await fs.writeFile(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "fixture",
              name: "Test fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  const info = await discover();
  await fs.writeFile(
    path.join(agent, "settings.json"),
    JSON.stringify({
      retry: { enabled: true, baseDelayMs: 10, maxRetries: 2 },
      compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 256 },
    }),
  );
  const child = spawn(
    info.node,
    [
      info.pi,
      "--mode",
      "rpc",
      "--offline",
      "--approve",
      "--no-extensions",
      "--no-mcp",
      "--tools",
      "read,grep,find,ls",
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--session-dir",
      path.join(agent, "sessions"),
    ],
    {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: agent },
    },
  );
  let buffer = "",
    events = [],
    waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buffer += d.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const row = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const event = JSON.parse(row);
        events.push(event);
        for (const [predicate, resolve] of waiters) {
          if (predicate(event)) resolve(event);
        }
      } catch {}
    }
  });
  let error = "";
  child.stderr.on("data", (d) => (error += d));
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("RPC timeout: " + error.slice(-500))),
        20000,
      );
      waiters.push([
        predicate,
        (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      ]);
    });
  try {
    const state = wait((e) => e.id === "state");
    child.stdin.write('{"id":"state","type":"get_state"}\r\n');
    assert.equal((await state).success, true);
    const settled = wait((e) => e.type === "agent_settled");
    child.stdin.write(
      JSON.stringify({
        id: "prompt",
        type: "prompt",
        message: "planning fixture",
      }) + "\n",
    );
    await settled;
    let partial,
      liveText = "";
    for (const e of events) {
      if (e.type === "message_start" && e.message.role === "assistant")
        partial = e.message;
      if (e.type === "message_update" && partial) {
        partial = applyStream(partial, e.assistantMessageEvent, e.usage);
        if (e.assistantMessageEvent.type === "text_delta")
          liveText = partial.content.map((c) => c?.text || "").join("");
      }
    }
    assert.equal(liveText, "中文\u2028stream ✓");
    assert.ok(events.some((e) => e.type === "message_update"));
    assert.ok(
      events.some(
        (e) => e.type === "message_end" && JSON.stringify(e).includes("中文"),
      ),
    );
    assert.deepEqual(requests[0].tools.map((t) => t.function.name).sort(), [
      "find",
      "grep",
      "ls",
      "read",
    ]);
    assert.ok(events.some((e) => e.type === "tool_execution_end" && e.isError));
    await assert.rejects(fs.access(path.join(root, "SHOULD_NOT_EXIST")));
    await assert.rejects(fs.access(path.join(root, "EXTENSION_WAS_LOADED")));
    failRetry = true;
    const retryStart = wait((e) => e.type === "auto_retry_start");
    const retryDone = wait((e) => e.type === "agent_settled");
    child.stdin.write(
      JSON.stringify({
        id: "retry",
        type: "prompt",
        message: "retry fixture",
      }) + "\n",
    );
    await retryStart;
    failRetry = false;
    await retryDone;
    assert.ok(events.some((e) => e.type === "auto_retry_end"));
    const compacted = wait((e) => e.id === "compact");
    child.stdin.write(
      JSON.stringify({ id: "compact", type: "compact" }) + "\n",
    );
    const compactResult = await compacted;
    assert.equal(compactResult.success, true, JSON.stringify(compactResult));
    assert.ok(compactResult.data.summary);
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill(), 1000).unref();
    server.close();
  }
});
