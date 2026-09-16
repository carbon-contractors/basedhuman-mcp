/**
 * config.ts — environment-driven configuration for the basedhuman-mcp STDIO bridge.
 *
 * All knobs are env vars so an agent operator can wire this into any MCP host
 * (Claude Desktop, Claude Code, Cursor, ...) without config-file surgery.
 */

import { z } from "zod";

const DEFAULT_URL = "https://www.carbon-contractors.com/api/basedhuman.mcp";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface BridgeConfig {
  /** Remote MCP endpoint (streamable HTTP). */
  url: URL;
  /** Private key for challenge-response wallet auth. Optional — read-only access without it. */
  privateKey: `0x${string}` | null;
  /** Extra headers forwarded on every request to the remote endpoint (multi-line "K: V"). */
  extraHeaders: Record<string, string>;
  /** Log verbosity to stderr. stdout is reserved for the MCP protocol. */
  logLevel: "error" | "warn" | "info" | "debug";
}

export const walletAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex wallet address");

export const privateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte (64 hex char) private key");

export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) headers[k] = v;
  }
  return headers;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const rawUrl = env.BASEDHUMAN_MCP_URL ?? DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`BASEDHUMAN_MCP_URL is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`BASEDHUMAN_MCP_URL must be http(s), got: ${url.protocol}`);
  }

  const rawKey = env.BASEDHUMAN_WALLET_PRIVATE_KEY ?? null;
  if (rawKey !== null && !privateKeySchema.safeParse(rawKey).success) {
    throw new ConfigError(
      "BASEDHUMAN_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte (64 hex char) private key",
    );
  }

  const logLevelRaw = (env.BASEDHUMAN_LOG ?? "info").toLowerCase();
  const logLevel = (["error", "warn", "info", "debug"] as const).includes(
    logLevelRaw as BridgeConfig["logLevel"],
  )
    ? (logLevelRaw as BridgeConfig["logLevel"])
    : "info";

  return {
    url,
    privateKey: rawKey as `0x${string}` | null,
    extraHeaders: parseHeaders(env.BASEDHUMAN_EXTRA_HEADERS),
    logLevel,
  };
}
