# @persistio/openclaw-plugin

OpenClaw plugin for [Persistio](https://persistio.ai) — persistent semantic memory for AI agents.

Hooks into OpenClaw's `before_prompt_build` and `agent_end` events to automatically recall relevant memories into every prompt and ingest new conversation turns after each run. Exposes `memory_search`, `memory_add`, `memory_delete`, and `memory_list` as agent tools.

## Requirements

- A running [Persistio](https://github.com/chriscoveyduck/persistio) instance (`api.persistio.ai` or self-hosted)
- OpenClaw `>=2026.3.24-beta.2`

## Installation

```bash
npm install -g @persistio/openclaw-plugin
```

Then register it in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "persistio": {
        "package": "@persistio/openclaw-plugin",
        "config": {
          "baseURL": "https://api.persistio.ai",
          "apiKey": "your-vault-api-key",
          "send": {
            "roles": {
              "user": "enabled",
              "agent": "enabled",
              "tool": "disabled"
            }
          }
        }
      }
    }
  }
}
```

## Configuration

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `baseURL` | string | ✅ | — | Base URL of your Persistio instance |
| `apiKey` | string | ✅ | — | Vault API key |
| `tokenBudget` | number | | `2000` | Max tokens to inject into the system prompt |
| `recallTopK` | number | | `10` | Number of memories to retrieve per recall |
| `recallTimeout` | number | | `5000` | HTTP timeout for recall requests (ms) |
| `send.roles.user` | `"enabled"` or `"disabled"` | | `"enabled"` | Send user messages to Persistio ingest |
| `send.roles.agent` | `"enabled"` or `"disabled"` | | `"enabled"` | Send agent/assistant messages to Persistio ingest |
| `send.roles.tool` | `"enabled"` or `"disabled"` | | `"disabled"` | Send tool messages to Persistio ingest |

`agent_end` receives a snapshot of the active OpenClaw transcript, so the plugin deduplicates per session and only sends each user, agent, or enabled tool message once per plugin process. Deduplication keys are bounded in memory and expire after 24 hours of session inactivity.

## Tools exposed

| Tool | Description |
|---|---|
| `memory_search` | Search memories by semantic query |
| `memory_add` | Manually store a fact |
| `memory_delete` | Delete a memory by ID |
| `memory_list` | List all memories in the vault |

## License

MIT
