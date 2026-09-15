#!/usr/bin/env node
/**
 * smoke-test.mjs — live smoke test for the basedhuman-mcp STDIO bridge.
 *
 * Not part of the vitest suite (network dependency); run manually:
 *   node scripts/smoke-test.mjs [endpoint-url]
 *
 * Verifies the full path: spawn dist/index.js over stdio, initialize,
 * tools/list (expect the ten real tools), call a read-only tool, clean shutdown.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const endpoint = process.argv[2] ?? "https://www.carbon-contractors.com/api/basedhuman.mcp";

const EXPECTED_TOOLS = [
  "search_whitepages",
  "request_human_work",
  "get_task_status",
  "confirm_task_completion",
  "register_notification_channel",
  "get_contractor",
  "list_categories",
  "get_reputation",
  "dispute_task",
  "get_signed_verdict",
];

const child = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, BASEDHUMAN_MCP_URL: endpoint, BASEDHUMAN_LOG: "debug" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const responses = [];

child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      console.error("UNPARSEABLE LINE:", line.slice(0, 200));
    }
  }
});

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

await sleep(500);

// 1. initialize
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  },
});

let init = null;
for (let i = 0; i < 40 && !init; i++) {
  await sleep(100);
  init = responses.find((r) => r.id === 1);
}
if (!init) throw new Error("no initialize response");
console.log("✓ initialize:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
const protocolVersion = init.result?.protocolVersion;

// 2. initialized notification
send({ jsonrpc: "2.0", method: "notifications/initialized" });
await sleep(500);

// 3. tools/list
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
let tools = null;
for (let i = 0; i < 40 && !tools; i++) {
  await sleep(100);
  tools = responses.find((r) => r.id === 2);
}
if (!tools) throw new Error("no tools/list response");

const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log("✓ tools/list:", names.length, "tools");
const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
const extra = names.filter((t) => !EXPECTED_TOOLS.includes(t));
if (missing.length) console.log("  MISSING:", missing);
if (extra.length) console.log("  extra:", extra);

// 4. read-only tool call: list_categories
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_categories", arguments: {} } });
let cats = null;
for (let i = 0; i < 40 && !cats; i++) {
  await sleep(100);
  cats = responses.find((r) => r.id === 3);
}
if (!cats) throw new Error("no list_categories response");
const catText = cats.result?.content?.[0]?.text;
if (cats.result?.isError) {
  console.log("✗ list_categories returned isError:", catText?.slice(0, 200));
} else {
  const parsed = JSON.parse(catText);
  console.log("✓ list_categories:", parsed.count ?? parsed.length ?? "?", "categories");
}

console.log("protocol version negotiated:", protocolVersion);
child.kill();
process.exit(0);
