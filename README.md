# @persistio/openclaw-plugin

OpenClaw plugin for [Persistio](https://persistio.ai) — persistent semantic memory for AI agents.

Hooks into OpenClaw's `before_prompt_build` and `agent_end` events to automatically recall relevant memories into every prompt and ingest new conversation turns after each run. Exposes `memory_search`, `memory_add`, `memory_delete`, and `memory_list` as agent tools.

## Requirements

- A running [Persistio](https://github.com/chriscoveyduck/persistio) instance (`api.persistio.ai` or self-hosted)
- OpenClaw `>=2026.3.24-beta.2`

## Installation

```bash
openclaw plugins install npm:@persistio/openclaw-plugin
openclaw plugins enable openclaw-persistio
openclaw gateway restart
openclaw plugins inspect openclaw-persistio --runtime --json
```

Then register it in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "openclaw-persistio": {
        "enabled": true,
        "package": "@persistio/openclaw-plugin",
        "config": {
          "baseURL": "https://api.persistio.ai",
          "apiKey": "your-vault-api-key",
          "recallMinSimilarity": 0.3,
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
| `recallMinSimilarity` | number from `0` to `1` | | Persistio server default | Optional semantic recall quality floor |
| `recallTimeout` | number | | `5000` | HTTP timeout for recall requests (ms) |
| `ingest.timeoutMs` | number | | `30000` | HTTP timeout for ingest requests (ms). Timed-out requests are treated as ambiguous and not retried automatically |
| `ingest.maxChunkChars` | number | | `6000` | Maximum characters per chunk sent to Persistio |
| `ingest.maxChunksPerTurn` | number | | `12` | Maximum chunks sent from a single OpenClaw turn |
| `ingest.skipSubagentSessions` | boolean | | `true` | Skip `agent:*` sessions unless they are `agent:main:*` |
| `ingest.user.maxCharsPerMessage` | number | | `24000` | Maximum user-message characters considered for ingest before chunking |
| `ingest.agent.mode` | `"bounded"` or `"raw"` | | `"bounded"` | Assistant ingest shaping mode. `bounded` collapses obvious large noisy blocks before chunking |
| `ingest.agent.maxCharsPerMessage` | number | | `24000` | Maximum assistant-message characters considered after filtering |
| `ingest.agent.maxCharsAfterFiltering` | number | | `9000` | Maximum assistant-message characters retained after deterministic filtering |
| `ingest.agent.maxCharsPerTurn` | number | | `24000` | Maximum assistant-message characters sent from one turn |
| `send.roles.user` | `"enabled"` or `"disabled"` | | `"enabled"` | Send user messages to Persistio ingest |
| `send.roles.agent` | `"enabled"` or `"disabled"` | | `"enabled"` | Send agent/assistant messages to Persistio ingest |
| `send.roles.tool` | `"enabled"` or `"disabled"` | | `"disabled"` | Send tool messages to Persistio ingest |

Recall is fail-open by design. If Persistio does not answer within `recallTimeout`, the plugin returns no memory for that turn instead of blocking the OpenClaw lane. After three consecutive recall/search failures it opens a 60 second circuit breaker and skips recall immediately during the cooldown. The plugin also registers a bounded `before_prompt_build` hook timeout; operators can still override this in OpenClaw with `plugins.entries.<id>.hooks.timeouts.before_prompt_build`.

`agent_end` receives a snapshot of the active OpenClaw transcript, so the plugin deduplicates per session and only sends each user, agent, or enabled tool message once per plugin process. Deduplication keys are bounded in memory and expire after 24 hours of session inactivity.

Assistant ingest is bounded before any network call. By default the plugin skips non-main `agent:*` sessions, collapses oversized code/log/diff/blob/table-shaped assistant content into omission markers, caps assistant ingest per message and per turn, then chunks all ingest content below `ingest.maxChunkChars`. Persistio still performs server-side extraction and curation; the plugin only enforces a deterministic transport-safe shape.

## Tools exposed

| Tool | Description |
|---|---|
| `memory_search` | Search memories by semantic query |
| `memory_add` | Manually store a fact |
| `memory_delete` | Delete a memory by ID |
| `memory_list` | List all memories in the vault |

## License

MIT
