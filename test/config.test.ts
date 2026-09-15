import { describe, it, expect } from "vitest";
import { loadConfig, parseHeaders, ConfigError } from "../src/config.js";

describe("loadConfig", () => {
  const baseEnv = { BASEDHUMAN_MCP_URL: "https://example.com/api/basedhuman.mcp" };

  it("applies defaults with an empty env", () => {
    const c = loadConfig({});
    expect(c.url.toString()).toBe("https://www.carbon-contractors.com/api/basedhuman.mcp");
    expect(c.privateKey).toBeNull();
    expect(c.extraHeaders).toEqual({});
    expect(c.logLevel).toBe("info");
  });

  it("accepts an explicit URL and private key", () => {
    const c = loadConfig({
      ...baseEnv,
      BASEDHUMAN_WALLET_PRIVATE_KEY:
        "0x" + "a".repeat(64),
    });
    expect(c.url.hostname).toBe("example.com");
    expect(c.privateKey).toBe("0x" + "a".repeat(64));
  });

  it("rejects a malformed URL", () => {
    expect(() => loadConfig({ BASEDHUMAN_MCP_URL: "not a url" })).toThrow(ConfigError);
  });

  it("rejects a non-http(s) URL", () => {
    expect(() => loadConfig({ BASEDHUMAN_MCP_URL: "ftp://example.com" })).toThrow(ConfigError);
  });

  it("rejects a malformed private key", () => {
    expect(() =>
      loadConfig({ ...baseEnv, BASEDHUMAN_WALLET_PRIVATE_KEY: "0x1234" }),
    ).toThrow(ConfigError);
  });

  it("rejects a private key that is not hex", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        BASEDHUMAN_WALLET_PRIVATE_KEY: "0x" + "z".repeat(64),
      }),
    ).toThrow(ConfigError);
  });

  it("maps unknown log level to info", () => {
    const c = loadConfig({ ...baseEnv, BASEDHUMAN_LOG: "verbose" });
    expect(c.logLevel).toBe("info");
  });
});

describe("parseHeaders", () => {
  it("parses multi-line headers", () => {
    expect(parseHeaders("X-A: 1\nX-B: 2")).toEqual({ "X-A": "1", "X-B": "2" });
  });

  it("tolerates lines without a colon", () => {
    expect(parseHeaders("garbage\nX-A: 1")).toEqual({ "X-A": "1" });
  });

  it("returns empty for undefined", () => {
    expect(parseHeaders(undefined)).toEqual({});
  });
});
