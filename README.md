# basedhuman-mcp

STDIO bridge to [Carbon Contractors](https://carbon-contractors.com) — the HaaS
platform where AI agents hire and pay humans via USDC on Base.

Runs as a local MCP server over STDIO and forwards every JSON-RPC message
verbatim to the hosted streamable-HTTP endpoint at
`https://www.carbon-contractors.com/api/basedhuman.mcp`. The tool surface,
validation and business logic all live server-side; this package is the
ergonomic local entrypoint so you don't have to hand-configure an HTTP endpoint.

## Tools (defined server-side, surfaced through this bridge)

`search_whitepages`, `request_human_work`, `get_task_status`,
`confirm_task_completion`, `register_notification_channel`, `get_contractor`,
`list_categories`, `get_reputation`, `dispute_task`, `get_signed_verdict`

## Install & configure

Not yet published to npm (publishing is gated on supply-chain hardening, tracked
as CC-045). Until then, install from this repository:

    git clone https://github.com/carbon-contractors/basedhuman-mcp
    cd basedhuman-mcp
    npm install
    npm run build

### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "carbon-contractors": {
      "command": "node",
      "args": ["/absolute/path/to/basedhuman-mcp/dist/index.js"],
      "env": {
        "BASEDHUMAN_MCP_URL": "https://www.carbon-contractors.com/api/basedhuman.mcp"
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASEDHUMAN_MCP_URL` | `https://www.carbon-contractors.com/api/basedhuman.mcp` | Remote endpoint |
| `BASEDHUMAN_WALLET_PRIVATE_KEY` | — | Private key for challenge-response wallet auth. Without it the bridge runs anonymous (read-only tools) |
| `BASEDHUMAN_EXTRA_HEADERS` | — | Extra headers on every request, multi-line `Name: value` |
| `BASEDHUMAN_LOG` | `info` | stderr log level: `error` \| `warn` \| `info` \| `debug` |

### Wallet authentication (optional)

The remote endpoint authenticates callers with a challenge-response signature
scheme (EOA or ERC-1271 smart wallet). The bridge handles it automatically when
`BASEDHUMAN_WALLET_PRIVATE_KEY` is set:

1. It requests a challenge (single-use nonce, 60s TTL) from the endpoint's
   `/challenge` route.
2. Signs the exact challenge message with the private key.
3. Attaches `x-caller-wallet` / `x-caller-signature` / `x-caller-nonce` headers
   to the session-creating request.
4. On session expiry (~30 min idle) it transparently re-authenticates with a
   fresh challenge and replays the pending request.

For smart wallets (ERC-1271, e.g. Coinbase Smart Wallet) the remote verifier is
on-chain aware; this bridge signs locally with the raw private key, which suits
EOA-style operator keys. (Smart-wallet signing from STDIO would need a signer
process; not currently supported.)

## Development

    npm install
    npm run build      # tsc → dist/
    npm test           # vitest, 19 unit tests
    npm run lint
    npm run typecheck
    node scripts/smoke-test.mjs   # live smoke test against the hosted endpoint

## Security notes

- The bridge performs no argument validation of its own — every message is
  forwarded verbatim and validated by the remote server, which applies Zod
  schemas to every tool input. This package is transport-only.
- `BASEDHUMAN_WALLET_PRIVATE_KEY` is a hot key by necessity (STDIO signing).
  Use a dedicated operator key, not a treasury key.
- Supply-chain hardening and npm publish are tracked in CC-045; this package
  must not be published to npm before that work is complete.

## License

MIT © Aaron Clifft
