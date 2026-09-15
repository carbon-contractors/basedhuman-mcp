#!/usr/bin/env node
/**
 * auth-smoke-test.mjs — live test of the challenge-response auth path.
 *
 * Generates a THROWAWAY EOA key in memory (never persisted, never funded),
 * runs the bridge with it, and verifies the remote accepts the handshake.
 *
 * Why this proves the auth path: the remote route verifies the wallet
 * signature at session creation and answers 401 on failure. A clean
 * initialize response therefore proves challenge → sign → on-chain verify →
 * authenticated session all worked. The throwaway wallet is not registered
 * on the platform, which is fine — auth only proves key ownership, not
 * registration. No mutating tool is called.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const endpoint =
  process.argv[2] ?? "https://www.carbon-contractors.com/api/basedhuman.mcp";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
console.log("throwaway wallet:", account.address);

const child = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    BASEDHUMAN_MCP_URL: endpoint,
    BASEDHUMAN_WALLET_PRIVATE_KEY: key,
    BASEDHUMAN_LOG: "debug",
  },
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
    if (line) {
      try {
        responses.push(JSON.parse(line));
      } catch {
        console.error("UNPARSEABLE:", line.slice(0, 200));
      }
    }
  }
});

child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "auth-smoke-test", version: "0.0.1" },
    },
  }) + "\n",
);

let init = null;
for (let i = 0; i < 60 && !init; i++) {
  await sleep(100);
  init = responses.find((r) => r.id === 1);
}

if (!init) {
  console.error("✗ no initialize response (bridge may have failed auth or network)");
  child.kill();
  process.exit(1);
}
if (init.error) {
  console.error("✗ initialize returned JSON-RPC error:", JSON.stringify(init.error));
  child.kill();
  process.exit(1);
}

console.log(
  "✓ authenticated initialize accepted:",
  init.result?.serverInfo?.name,
  init.result?.serverInfo?.version,
);
console.log("challenge-response wallet auth verified end-to-end");
child.kill();
process.exit(0);
