# openclaw-persistio

OpenClaw plugin that adds semantic memory to your agents via [Persistio](https://persistio.ai).

Persistio automatically extracts facts, preferences, and decisions from conversations and recalls the most relevant memories at the start of each session — giving your agents genuine long-term memory.

---

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- A Persistio account at [persistio.ai](https://persistio.ai), or a self-hosted Persistio instance

---

## Installation

Install directly from GitHub:

```bash
openclaw plugins install github:Persistio/openclaw-persistio
```

Or clone and install from a local path:

```bash
git clone https://github.com/Persistio/openclaw-persistio.git
openclaw plugins install ./openclaw-persistio
```

---

## Configuration

Add the following to your OpenClaw config (typically `~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "openclaw-persistio": {
      "baseURL": "https://api.persistio.ai",
      "apiKey": "your-tenant-api-key",
      "tokenBudget": 2000,
      "recallTopK": 10
    }
  }
}
```

### Config reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `baseURL` | ✅ | — | Your Persistio API URL (e.g. `https://api.persistio.ai`) |
| `apiKey` | ✅ | — | Your tenant API key |
| `tokenBudget` | | `2000` | Maximum tokens returned by recall |
| `recallTopK` | | `10` | Number of memories to retrieve per query |
| `recallTimeout` | | *(unset)* | Recall request timeout in milliseconds |

---

## Seeding existing memories

If you have existing OpenClaw session history you would like to import into Persistio, use the hydration script:

→ [`scripts/persistio-hydrate.mjs`](scripts/persistio-hydrate.mjs)

See [scripts/README.md](scripts/README.md) for usage details.

---

## Links

- [persistio.ai](https://persistio.ai)
- [api.persistio.ai](https://api.persistio.ai)

---

## License

[BSL 1.1](LICENSE)
