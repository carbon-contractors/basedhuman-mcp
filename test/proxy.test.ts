import { describe, it, expect } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { runProxy, type StdioLike } from "../src/proxy.js";

/** Minimal fake stdio transport: capture inbound from host, let test drive. */
class FakeStdio implements StdioLike {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  sent: JSONRPCMessage[] = [];
  closed = false;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  /** Simulate the host writing a message to our stdin. */
  hostSends(msg: JSONRPCMessage): void {
    this.onmessage?.(msg);
  }
}

/**
 * Fake fetch that emulates the remote endpoint's contract:
 * - POST initialize (no session) → 200 JSON result + mcp-session-id header
 * - POST with unknown session → 404 JSON-RPC error
 * - POST with known session → 200 JSON result
 * - POST notifications → 202
 * - GET with session → SSE stream (kept open, never used in these tests)
 */
function makeFakeRemote(opts: {
  failFirstSession?: boolean;
  onRequest?: (body: { method: string; id?: string | number }) => void;
} = {}) {
  const sessions = new Set<string>();
  let sessionCounter = 0;
  let firstSession = true;
  const posts: Record<string, unknown>[] = [];

  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET") {
      const sid = new Headers(init.headers).get("mcp-session-id");
      if (sid && sessions.has(sid)) {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { status: 400 });
    }

    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      opts.onRequest?.(body as { method: string; id?: string | number });
      const headers = new Headers(init.headers);
      const sid = headers.get("mcp-session-id");

      const isInit = body.method === "initialize" && body.id !== undefined;

      if (!sid) {
        // Session-creating request.
        if (isInit) {
          if (opts.failFirstSession && firstSession) {
            firstSession = false;
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "boom" } }),
              { status: 500 },
            );
          }
          firstSession = false;
          const newSid = `sess-${++sessionCounter}`;
          sessions.add(newSid);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "fake", version: "1.0.0" },
              },
            }),
            { status: 200, headers: { "content-type": "application/json", "mcp-session-id": newSid } },
          );
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session expired or not found. Re-initialize to continue.", id: null } }), { status: 404 });
      }

      if (!sessions.has(sid)) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session expired or not found. Re-initialize to continue.", id: null } }),
          { status: 404 },
        );
      }

      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      // Normal request on a live session.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: { echoed: body.method, session: sid },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("{}", { status: 405 });
  }) as typeof fetch;

  return { fetchFn, sessions, posts };
}

const ENDPOINT = new URL("https://remote.example/api/basedhuman.mcp");

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("runProxy", () => {
  it("passes the host initialize through and relays the response", async () => {
    const remote = makeFakeRemote();
    const stdio = new FakeStdio();
    const run = runProxy(ENDPOINT, {
      fetchFn: remote.fetchFn,
      authHeadersProvider: async () => null,
      stdio,
    });
    await wait(20);

    stdio.hostSends({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "host", version: "1" } },
    } as JSONRPCMessage);
    await wait(20);

    expect(stdio.sent).toHaveLength(1);
    const reply = stdio.sent[0] as { id: number; result?: { serverInfo?: { name: string } } };
    expect(reply.id).toBe(1);
    expect(reply.result?.serverInfo?.name).toBe("fake");

    stdio.hostSends({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
    await wait(20);
    expect(stdio.sent).toHaveLength(1); // 202, no body

    stdio.hostSends({ jsonrpc: "2.0", id: 2, method: "tools/list" } as JSONRPCMessage);
    await wait(20);
    expect(stdio.sent).toHaveLength(2);

    await stdio.close();
    await run;
  });

  it("sends auth headers on the session-creating request", async () => {
    const remote = makeFakeRemote();
    const stdio = new FakeStdio();
    let seenHeaders: Headers | null = null;

    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { method?: string };
        if (body.method === "initialize") seenHeaders = new Headers(init.headers);
      }
      return remote.fetchFn(url, init);
    }) as typeof fetch;

    const run = runProxy(ENDPOINT, {
      fetchFn,
      authHeadersProvider: async () => ({
        "x-caller-wallet": "0x" + "1".repeat(40),
        "x-caller-signature": "0xabc",
        "x-caller-nonce": "nonce-1",
      }),
      stdio,
    });
    await wait(20);

    stdio.hostSends({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} } as JSONRPCMessage);
    await wait(20);

    expect(seenHeaders?.get("x-caller-wallet")).toBe("0x" + "1".repeat(40));
    expect(seenHeaders?.get("x-caller-nonce")).toBe("nonce-1");

    await stdio.close();
    await run;
  });

  it("re-authenticates transparently when the session expires (404)", async () => {
    const remote = makeFakeRemote();
    const stdio = new FakeStdio();
    let authCalls = 0;

    const run = runProxy(ENDPOINT, {
      fetchFn: remote.fetchFn,
      authHeadersProvider: async () => {
        authCalls++;
        return { "x-caller-wallet": "0x" + "1".repeat(40), "x-caller-signature": "0x" + "s".repeat(130), "x-caller-nonce": `n${authCalls}` };
      },
      stdio,
    });
    await wait(20);

    // Host initialize → session-1
    stdio.hostSends({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} } as JSONRPCMessage);
    await wait(20);
    expect(authCalls).toBe(1);
    expect(stdio.sent).toHaveLength(1);

    // Remote purges the session.
    remote.sessions.clear();

    // Host request → 404 → re-auth (new nonce, internal initialize) → replay.
    stdio.hostSends({ jsonrpc: "2.0", id: 2, method: "tools/list" } as JSONRPCMessage);
    await wait(50);

    expect(authCalls).toBe(2); // fresh challenge
    // Internal re-init responses are swallowed; the host sees only its own reply.
    const reply = stdio.sent.find((m) => (m as { id?: unknown }).id === 2) as
      | { id: number; result?: { session?: string } }
      | undefined;
    expect(reply).toBeDefined();
    expect(reply?.result?.session).toBe("sess-2");
    expect(
      stdio.sent.some(
        (m) => (m as { id?: unknown }).id === "__basedhuman_bridge_reinit__",
      ),
    ).toBe(false);

    await stdio.close();
    await run;
  });

  it("shares one re-auth among concurrent requests on a dead session", async () => {
    const remote = makeFakeRemote();
    const stdio = new FakeStdio();
    let authCalls = 0;

    const run = runProxy(ENDPOINT, {
      fetchFn: remote.fetchFn,
      authHeadersProvider: async () => {
        authCalls++;
        await wait(10); // force overlap of concurrent re-auth attempts
        return null;
      },
      stdio,
    });
    await wait(20);

    stdio.hostSends({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} } as JSONRPCMessage);
    await wait(20);

    remote.sessions.clear();

    stdio.hostSends({ jsonrpc: "2.0", id: 2, method: "tools/list" } as JSONRPCMessage);
    stdio.hostSends({ jsonrpc: "2.0", id: 3, method: "tools/list" } as JSONRPCMessage);
    await wait(100);

    expect(authCalls).toBe(2); // one initial + one shared re-auth
    const ids = stdio.sent.map((m) => (m as { id?: unknown }).id);
    expect(ids).toContain(2);
    expect(ids).toContain(3);

    await stdio.close();
    await run;
  });

  it("answers a host request with a JSON-RPC error when the remote is unreachable", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const stdio = new FakeStdio();
    const run = runProxy(ENDPOINT, {
      fetchFn: failing,
      authHeadersProvider: async () => null,
      stdio,
    });
    await wait(20);

    stdio.hostSends({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} } as JSONRPCMessage);
    await wait(50);

    const err = stdio.sent.find((m) => (m as { id?: unknown }).id === 7) as
      | { error?: { message: string } }
      | undefined;
    expect(err?.error?.message).toContain("remote request failed");

    await stdio.close();
    await run;
  });
});
