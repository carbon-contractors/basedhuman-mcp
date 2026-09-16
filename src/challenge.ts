/**
 * challenge.ts — challenge-response wallet authentication (NOR-178 client side).
 *
 * Mirrors src/lib/auth/wallet-challenge.ts in carbon-contractors.com:
 *   1. POST {challengeUrl} { walletAddress } → { nonce, expiresAt, message }
 *   2. sign `message` with the wallet private key
 *   3. attach x-caller-wallet / x-caller-signature / x-caller-nonce headers
 *
 * The signed bytes are exactly `buildChallengeMessage` from the server — the
 * message is returned by the challenge endpoint itself, so the client never
 * reconstructs it. That is deliberate: the 2026-08-28 server bug was two sides
 * building this string from two clocks.
 */

export interface ChallengeHeaders {
  "x-caller-wallet": string;
  "x-caller-signature": `0x${string}`;
  "x-caller-nonce": string;
}

export interface ChallengeResponse {
  nonce: string;
  expiresAt: number;
  message: string;
}

export interface ChallengeDeps {
  /** POSTs the challenge request. Injectable for tests. */
  post: (url: string, body: unknown, headers: Record<string, string>) => Promise<ChallengeResponse>;
  /** Signs the challenge message. Injectable for tests. */
  sign: (message: string) => Promise<`0x${string}`>;
}

export class ChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChallengeError";
  }
}

function isChallengeResponse(v: unknown): v is ChallengeResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.nonce === "string" &&
    typeof r.expiresAt === "number" &&
    typeof r.message === "string"
  );
}

/**
 * Runs the full challenge-response flow and returns the headers to attach to
 * every subsequent MCP request. Throws ChallengeError on any failure.
 */
export async function getAuthHeaders(
  challengeUrl: string,
  walletAddress: string,
  deps: ChallengeDeps,
): Promise<ChallengeHeaders> {
  let challenge: ChallengeResponse;
  try {
    challenge = await deps.post(challengeUrl, { walletAddress }, {});
  } catch (err) {
    throw new ChallengeError(
      `challenge request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isChallengeResponse(challenge)) {
    throw new ChallengeError("challenge endpoint returned an unexpected shape");
  }

  const signature = await deps.sign(challenge.message);

  return {
    "x-caller-wallet": walletAddress,
    "x-caller-signature": signature,
    "x-caller-nonce": challenge.nonce,
  };
}
