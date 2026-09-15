import { describe, it, expect } from "vitest";
import { getAuthHeaders, ChallengeError } from "../src/challenge.js";

describe("getAuthHeaders", () => {
  const goodChallenge = {
    nonce: "abc123",
    expiresAt: 1234567890,
    message: "carbon-contractors.com wants to verify wallet ownership\nNonce: abc123\nTimestamp: 123",
  };

  it("returns the three auth headers", async () => {
    const headers = await getAuthHeaders("http://x/challenge", "0x" + "1".repeat(40), {
      post: async () => goodChallenge,
      sign: async () => "0x" + "s".repeat(130),
    });
    expect(headers).toEqual({
      "x-caller-wallet": "0x" + "1".repeat(40),
      "x-caller-signature": "0x" + "s".repeat(130),
      "x-caller-nonce": "abc123",
    });
  });

  it("signs exactly the message returned by the challenge endpoint", async () => {
    let signed: string | undefined;
    await getAuthHeaders("http://x/challenge", "0x" + "1".repeat(40), {
      post: async () => goodChallenge,
      sign: async (message) => {
        signed = message;
        return "0x00";
      },
    });
    expect(signed).toBe(goodChallenge.message);
  });

  it("throws ChallengeError when the endpoint returns a bad shape", async () => {
    await expect(
      getAuthHeaders("http://x/challenge", "0x" + "1".repeat(40), {
        post: async () => ({ nonce: 1 }) as unknown,
        sign: async () => "0x00",
      }),
    ).rejects.toThrow(ChallengeError);
  });

  it("throws ChallengeError when the post fails", async () => {
    await expect(
      getAuthHeaders("http://x/challenge", "0x" + "1".repeat(40), {
        post: async () => {
          throw new Error("network down");
        },
        sign: async () => "0x00",
      }),
    ).rejects.toThrow(ChallengeError);
  });
});
