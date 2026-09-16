#!/usr/bin/env node
/**
 * bin-check.mjs — verify the built CLI is actually runnable as installed.
 *
 * This gate exists because of a real defect (round-1 review, CC-044): the
 * package shipped "bin": "./dist/index.js" while src/index.ts had no shebang,
 * so npm pack + clean install + .bin/basedhuman-mcp exec'd the JS as a shell
 * script. npm-installable implies the bin executes; this script proves it.
 *
 * What it checks, in escalating fidelity to a real install:
 *   1. dist/index.js starts with #!/usr/bin/env node (tsc preserves a leading
 *      #! from src — if this fails, the shebang was lost somewhere in build).
 *   2. dist/index.js has the +x bit set (npm fix-package performs this on
 *      install from the tarball; dev builds don't have it — we set it here).
 *   3. The CLEAN-INSTALL contract: `npm pack` → install the tarball into a
 *      temp prefix → spawn .bin/basedhuman-mcp WITHOUT node in argv (exactly
 *      how a host invokes it) → it must start, answer initialize over stdio,
 *      and shut down cleanly. No network: a local stub server stands in for
 *      the remote.
 *
 * Run: node scripts/bin-check.mjs            (assumes `npm run build` done)
 * Exit 0 = bin is healthy. Any failure exits 1 with a diagnostic.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const BIN_NAME = Object.keys(pkg.bin)[0];
const BIN_PATH = pkg.bin[BIN_NAME];

// ---------------------------------------------------------------------------
// 1. Shebang present in the built artifact
// ---------------------------------------------------------------------------
const distEntry = join(process.cwd(), BIN_PATH);
let head;
try {
  head = readFileSync(distEntry, "utf8").split("\n")[0];
} catch {
  console.error(`✗ bin target missing: ${distEntry} — run npm run build first`);
  process.exit(1);
}
if (head !== "#!/usr/bin/env node") {
  console.error(`✗ ${BIN_PATH} does not start with #!/usr/bin/env node — got: ${JSON.stringify(head)}`);
  process.exit(1);
}
console.log(`✓ ${BIN_PATH} starts with #!/usr/bin/env node`);

// ---------------------------------------------------------------------------
// 2. Executable bit on the built artifact (npm sets it on install; mirror that
//    here so direct repo runs of the bin also work)
// ---------------------------------------------------------------------------
const chmod = spawnSync("chmod", ["+x", distEntry]);
if (chmod.status !== 0) {
  console.error("✗ failed to set +x on dist entry");
  process.exit(1);
}
console.log(`✓ ${BIN_PATH} is executable`);

// ---------------------------------------------------------------------------
// 3. Clean-install + spawn contract (the round-1 failure mode, end to end)
// ---------------------------------------------------------------------------
// Local stand-in for the remote MCP endpoint. Speaks enough streamable-HTTP
// MCP for the bridge's startup path: initialize → result + mcp-session-id,
// notifications/initialized → 202, everything else → echoed result.
import { createServer } from "node:http";
const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = JSON.parse(body || "{}");
    if (msg.method === "initialize") {
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "bin-check-sess-1",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "bin-check-stub", version: "1.0.0" },
          },
        }),
      );
      return;
    }
    if (String(msg.method).startsWith("notifications/")) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const stubPort = server.address().port;
console.log(`stub remote listening on 127.0.0.1:${stubPort}`);

// Pack and install into a throwaway prefix.
const tmp = mkdtempSync(join(tmpdir(), "bh-bin-check-"));
try {
  const packOut = spawnSync("npm", ["pack", "--pack-destination", tmp], { encoding: "utf8" });
  if (packOut.status !== 0) {
    console.error("✗ npm pack failed:\n" + packOut.stderr);
    process.exit(1);
  }
  const tgz = packOut.stdout.trim().split("\n").pop().trim();
  console.log(`packed: ${tgz}`);

  const prefix = join(tmp, "prefix");
  const install = spawnSync("npm", ["install", "--prefix", prefix, join(tmp, tgz)], {
    encoding: "utf8",
  });
  if (install.status !== 0) {
    console.error("✗ clean-prefix install failed:\n" + install.stderr);
    process.exit(1);
  }
  console.log("installed into clean prefix");

  // THE test: invoke the bin exactly as a host would — bare executable, no
  // `node` in argv. If the shebang is missing/broken this exec's the JS as a
  // shell script (the round-1 defect), which fails fast with garbage output.
  const bin = join(prefix, "node_modules", ".bin", BIN_NAME);
  const child = spawn(bin, [], {
    env: {
      ...process.env,
      BASEDHUMAN_MCP_URL: `http://127.0.0.1:${stubPort}/mcp`,
      BASEDHUMAN_LOG: "info",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  let buf = "";
  let initReply = null;
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === 1) initReply = parsed;
      } catch {
        // garbage from a shell-interpreted bin would land here — the very
        // defect this gate exists to catch. stderr is inherited so it's visible.
      }
    }
  });

  await sleep(300); // let the bin process come up
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bin-check", version: "0.0.0" },
      },
    }) + "\n",
  );

  for (let i = 0; i < 100 && !initReply; i++) {
    await sleep(100);
  }
  if (!initReply) {
    console.error(
      "✗ installed bin did not answer initialize — if stderr shows /bin or sh syntax errors above, the shebang is broken (round-1 defect class)",
    );
    child.kill();
    process.exit(1);
  }
  if (initReply.error) {
    console.error("✗ initialize returned JSON-RPC error: " + JSON.stringify(initReply.error));
    child.kill();
    process.exit(1);
  }
  console.log(
    `✓ clean-installed bin answered initialize: ${initReply.result?.serverInfo?.name} ${initReply.result?.serverInfo?.version}`,
  );

  child.kill();
  console.log("bin-check: ALL GREEN");
  process.exit(0);
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
