/**
 * proxy.ts — the STDIO ↔ streamable-HTTP bridge.
 *
 * Pure transport-to-transport pump:
 *   host (Claude/Cursor/...) ⟷ StdioServerTransport ⟷ StreamableHTTPClientTransport ⟷ remote
 *
 * Design notes (read before touching):
 *
 * - No McpServer, no Client. The bridge is transport-layer only; every JSON-RPC
 *   message passes through verbatim, so tool schemas, Zod validation and the
 *   ten-tool surface are defined by the remote endpoint, never re-declared here.
 *
 * - `http.start()` is deliberately NEVER called. start() opens a GET SSE stream
 *   without a session id and the remote route answers session-less GETs with
 *   400. The session id is instead captured by send() from the initialize
 *   response headers, and the SDK opens the SSE stream itself after the
 *   `initialized` notification (202 → _startOrAuthSse with the session id set).
 *
 * - Session expiry (remote purges after 30 min idle) surfaces as
 *   StreamableHTTPError(404). Requests are transparently re-primed: fresh
 *   challenge (nonces are single-use, consumed at session creation), fresh
 *   initialize with an internal id, then replay. Internal re-init responses are
 *   swallowed so the host never sees a response it did not ask for.
 *
 * - Re-auth is serialized: concurrent requests against a dead session share a
 *   single in-flight re-init promise instead of racing to open N sessions.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const REINIT_ID = "__basedhuman_bridge_reinit__";

export interface ProxyDeps {
  /** Custom fetch (tests). Passed through to the HTTP transport. */
  fetchFn?: typeof fetch;
  /** Supplies auth headers (x-caller-wallet/-signature/-nonce) or null for anonymous. */
  authHeadersProvider: () => Promise<Record<string, string> | null>;
  /** Where diagnostics go. stdout belongs to the protocol. */
  log?: (level: "error" | "warn" | "info" | "debug", msg: string) => void;
  /** Injected stdio transport (tests). Defaults to the real one. */
  stdio?: StdioLike;
}

/**
 * Structural slice of StdioServerTransport the bridge needs. The real class
 * satisfies this structurally; tests substitute a fake so they never touch
 * process.stdin/stdout.
 */
export interface StdioLike {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
}

function isRequest(msg: JSONRPCMessage): msg is JSONRPCMessage & { id: string | number } {
  return "method" in msg && "id" in msg && msg.id !== undefined;
}

function isInternalReinitResponse(msg: JSONRPCMessage): boolean {
  return "result" in msg && "id" in msg && msg.id === REINIT_ID;
}

function jsonRpcError(id: string | number | null, message: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32001, message },
  } as JSONRPCMessage;
}

function is404Error(err: unknown): boolean {
  return err instanceof Error && (err as { code?: number }).code === 404;
}

/**
 * Runs the bridge until the stdio transport closes. Resolves on clean shutdown.
 */
export async function runProxy(endpoint: URL, deps: ProxyDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const stdio = deps.stdio ?? new StdioServerTransport();

  let http: StreamableHTTPClientTransport | null = null;
  let reAuthPromise: Promise<void> | null = null;

  async function makeTransport(
    authHeaders: Record<string, string> | null,
  ): Promise<StreamableHTTPClientTransport> {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: authHeaders ? { headers: authHeaders } : undefined,
      ...(deps.fetchFn ? { fetch: deps.fetchFn } : {}),
    });
    transport.onmessage = (msg) => {
      if (isInternalReinitResponse(msg)) {
        log("debug", "internal re-init acknowledged");
        return;
      }
      void stdio.send(msg);
    };
    transport.onerror = (err) => {
      log("error", `http transport error: ${err.message}`);
    };
    return transport;
  }

  async function initializeRemote(transport: StreamableHTTPClientTransport): Promise<void> {
    await transport.send({
      jsonrpc: "2.0",
      id: REINIT_ID,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "basedhuman-mcp-bridge", version: "0.2.0" },
      },
    } as unknown as JSONRPCMessage);
    // The remote McpServer rejects requests that arrive before the initialized
    // notification, so the re-auth sequence must complete the handshake, not
    // just start it. 202 Accepted, no response body.
    await transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    } as unknown as JSONRPCMessage);
  }

  /** Single-flight: concurrent callers share one re-init. */
  async function reAuth(): Promise<void> {
    if (reAuthPromise) return reAuthPromise;
    reAuthPromise = (async () => {
      const old = http;
      http = null;
      try {
        await old?.close();
      } catch {
        // already closed
      }
      const authHeaders = await deps.authHeadersProvider();
      const transport = await makeTransport(authHeaders);
      await initializeRemote(transport);
      http = transport;
      log("info", "re-initialized remote session");
    })();
    try {
      await reAuthPromise;
    } finally {
      reAuthPromise = null;
    }
  }

  async function ensureTransport(): Promise<StreamableHTTPClientTransport> {
    if (!http) {
      // No internal initialize here: the host's own `initialize` is what creates
      // the remote session, and the auth headers ride along on it. A bridge-side
      // initialize would burn the single-use challenge nonce and leave the host's
      // initialize failing with "Challenge already consumed". The internal
      // initialize exists only in the re-auth path, which mints a fresh challenge.
      const authHeaders = await deps.authHeadersProvider();
      http = await makeTransport(authHeaders);
      log("info", "remote transport ready");
    }
    return http;
  }

  async function handleSendFailure(msg: JSONRPCMessage, err: unknown): Promise<void> {
    if (!is404Error(err)) {
      log("error", `send failed: ${err instanceof Error ? err.message : String(err)}`);
      if (isRequest(msg)) {
        await stdio.send(jsonRpcError(msg.id, "Bridge: remote request failed"));
      }
      return;
    }

    // Session expired — re-prime with a fresh challenge and replay.
    log("info", "session expired; re-authenticating");
    try {
      await reAuth();
    } catch (authErr) {
      log(
        "error",
        `re-auth failed: ${authErr instanceof Error ? authErr.message : String(authErr)}`,
      );
      if (isRequest(msg)) {
        await stdio.send(
          jsonRpcError(msg.id, "Bridge: session expired and re-authentication failed"),
        );
      }
      return;
    }

    try {
      await http?.send(msg);
      log("debug", "replayed message after re-auth");
    } catch (replayErr) {
      log(
        "error",
        `replay failed: ${replayErr instanceof Error ? replayErr.message : String(replayErr)}`,
      );
      if (isRequest(msg)) {
        await stdio.send(jsonRpcError(msg.id, "Bridge: replay after re-auth failed"));
      }
    }
  }

  stdio.onmessage = (msg) => {
    void (async () => {
      try {
        const transport = await ensureTransport();
        await transport.send(msg);
      } catch (err) {
        await handleSendFailure(msg, err);
      }
    })();
  };

  stdio.onerror = (err) => {
    log("error", `stdio transport error: ${err.message}`);
  };

  const closed = new Promise<void>((resolve) => {
    stdio.onclose = () => {
      log("info", "stdio closed; shutting down bridge");
      const current = http;
      http = null;
      try {
        void current?.close();
      } catch {
        // already closed
      }
      resolve();
    };
  });

  await stdio.start();
  log("info", `bridge ready: ${endpoint.toString()}`);
  await closed;
}
