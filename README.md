# @persistio/openclaw-plugin

OpenClaw plugin for [Persistio](https://persistio.ai) — persistent semantic memory for AI agents.

Hooks into OpenClaw's `before_prompt_build` and `agent_end` events to recall a small memory context into prompts and ingest new conversation turns after each run. Registers as an OpenClaw memory provider with compatible `memory_search` and `memory_get` tools, plus optional Persistio management tools under the `persistio_*` namespace.

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

To upgrade an existing install, use the same pinned npm source and restart the Gateway:

```bash
openclaw plugins install npm:@persistio/openclaw-plugin@0.1.8
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
          "tokenBudget": 400,
          "recallTopK": 4,
          "recallTimeout": 1500,
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
    },
    "slots": {
      "memory": "openclaw-persistio"
    }
  }
}
```

## Configuration

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `baseURL` | string | ✅ | — | Base URL of your Persistio instance |
| `apiKey` | string | ✅ | — | Vault API key |
| `tokenBudget` | number | | `400` | Max tokens to inject into the system prompt |
| `recallTopK` | number | | `4` | Number of memories to retrieve per recall |
| `recallMinSimilarity` | number from `0` to `1` | | Persistio server default | Optional semantic recall quality floor |
| `recallTimeout` | number | | `1500` | HTTP timeout for recall requests (ms) |
| `recallIncludePending` | boolean | | `false` | Include fresh candidate memories in recall results |
| `includeRelatedMemories` | boolean | | `false` | Include graph-related memories in prompt recall bundles |
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

Prompt recall intentionally defaults to a small direct semantic bundle. `includeRelatedMemories` and `recallIncludePending` are opt-in because graph expansion and fresh candidates increase context size and tail latency on interactive channels.

`agent_end` receives a snapshot of the active OpenClaw transcript, so the plugin deduplicates per session and only sends each user, agent, or enabled tool message once per plugin process. Deduplication keys are bounded in memory and expire after 24 hours of session inactivity.

Assistant ingest is bounded before any network call. By default the plugin skips non-main `agent:*` sessions, collapses oversized code/log/diff/blob/table-shaped assistant content into omission markers, caps assistant ingest per message and per turn, then chunks all ingest content below `ingest.maxChunkChars`. Persistio still performs server-side extraction and curation; the plugin only enforces a deterministic transport-safe shape.

## Tools exposed

| Tool | Description |
|---|---|
| `memory_search` | Required OpenClaw-compatible semantic memory search. Returns bounded structured results with `persistio://memory/<id>` paths |
| `memory_get` | Required OpenClaw-compatible exact memory read for paths returned by `memory_search` |
| `persistio_memory_add` | Optional manual fact store |
| `persistio_memory_delete` | Optional memory deletion by ID |
| `persistio_memory_list` | Optional vault memory listing |

## License

MIT
