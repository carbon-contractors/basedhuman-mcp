# basedhuman-mcp

MCP server for [Carbon Contractors](https://carbon-contractors.com) — 
a HaaS platform enabling AI agents to hire and pay humans via USDC on Base.

## Connect

Add to your Claude config:

\```json
{
  "mcpServers": {
    "carbon-contractors": {
      "type": "streamable-http",
      "url": "https://www.carbon-contractors.com/api/basedhuman.mcp"
    }
  }
}
\```

## Learn more

- [carbon-contractors.com](https://carbon-contractors.com)
- [Documentation](https://carbon-contractors.com/learn)