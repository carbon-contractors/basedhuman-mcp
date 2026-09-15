/**
 * index.ts — basedhuman-mcp entrypoint.
 *
 * STDIO bridge to the Carbon Contractors Base-Human marketplace MCP endpoint.
 * See README.md for configuration.
 */

import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.js";
import { getAuthHeaders, type ChallengeResponse } from "./challenge.js";
import { runProxy } from "./proxy.js";

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = "error" | "warn" | "info" | "debug";

function makeLogger(level: LogLevel) {
  return (lvl: LogLevel, msg: string) => {
    if (LEVEL_ORDER[lvl] > LEVEL_ORDER[level]) return;
    process.stderr.write(`[basedhuman-mcp] ${lvl}: ${msg}\n`);
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = makeLogger(config.logLevel);

  const authHeadersProvider = async (): Promise<Record<string, string> | null> => {
    const extra = config.extraHeaders;
    if (!config.privateKey) {
      if (Object.keys(extra).length > 0) return extra;
      return null;
    }

    const account = privateKeyToAccount(config.privateKey);

    // NB: the endpoint path has no trailing slash, so relative resolution
    // ("./challenge") would drop the last segment and hit /api/challenge —
    // a live test caught this. Append to the full pathname instead.
    const challengeUrl = new URL(config.url.pathname.replace(/\/$/, "") + "/challenge", config.url).toString();
    const headers = await getAuthHeaders(challengeUrl, account.address, {
      post: async (url, body, headers): Promise<ChallengeResponse> => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`challenge endpoint returned ${res.status}: ${text.slice(0, 200)}`);
        }
        return (await res.json()) as ChallengeResponse;
      },
      // EOA signMessage is local ECDSA math over the key — no wallet client, no
      // RPC, no chain. (The first live auth test failed on exactly this: a
      // chain-less http() transport throws at sign time.)
      sign: (message) => account.signMessage({ message }),
    });

    return { ...extra, ...headers };
  };

  await runProxy(config.url, {
    authHeadersProvider,
    log,
  });
}

main().catch((err) => {
  process.stderr.write(
    `[basedhuman-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
