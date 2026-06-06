# @persistio/openclaw-plugin

OpenClaw-native long-term memory powered by Persistio.

This is the production Persistio plugin for OpenClaw. Version `0.2.x` promotes the OpenClaw-native memory-slot architecture that was tested separately as `openclaw-persistio-v2`.

## Design

Persistio v2 separates the memory surfaces:

- `memory_recall` lets the model explicitly retrieve durable Persistio memory.
- `memory_store` stores a deliberate durable fact, preference, decision, or project note.
- `memory_forget` deletes a known memory id or returns candidate memories for a query.
- `autoRecall` optionally injects a small bounded memory block before a turn.
- `autoCapture` optionally captures bounded post-turn messages without awaiting Persistio from the OpenClaw hook.

The plugin registers as an OpenClaw memory plugin and provides prompt guidance. It does not replace OpenClaw's generic `memory_search` / `memory_get` tools in this first v2 package.

## Install

```bash
openclaw plugins install npm:@persistio/openclaw-plugin@0.2.0
openclaw plugins enable openclaw-persistio-v2
openclaw gateway restart
```

To test it as the active memory slot:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-persistio-v2"
    },
    "entries": {
      "openclaw-persistio-v2": {
        "enabled": true,
        "package": "@persistio/openclaw-plugin",
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "baseURL": "https://api.persistio.ai",
          "apiKey": "your-vault-api-key",
          "autoRecall": true,
          "autoCapture": true,
          "recall": {
            "timeoutMs": 1200,
            "maxResults": 4,
            "tokenBudget": 400,
            "minSimilarity": 0.45,
            "includePending": false,
            "includeRelated": false
          },
          "capture": {
            "timeoutMs": 10000,
            "roles": {
              "user": "enabled",
              "assistant": "bounded",
              "tool": "disabled"
            }
          }
        }
      }
    }
  }
}
```

`hooks.allowConversationAccess` is required when `autoCapture` is enabled because the plugin reads the completed conversation snapshot from `agent_end`.

## Configuration

| Option | Default | Description |
|---|---:|---|
| `autoRecall` | `true` | Inject a small fail-open memory block before the model turn |
| `autoCapture` | `true` | Capture bounded post-turn messages asynchronously |
| `recall.timeoutMs` | `1200` | HTTP timeout for recall and recall-bundle calls |
| `recall.maxResults` | `4` | Maximum memories returned by recall |
| `recall.tokenBudget` | `400` | Approximate prompt-token budget for auto-recall |
| `recall.minSimilarity` | unset | Optional Persistio similarity floor |
| `recall.includePending` | `false` | Include pending candidate memories in hot-path recall |
| `recall.includeRelated` | `false` | Include graph-related memories in hot-path recall |
| `recall.queryMaxChars` | `1200` | Maximum latest-user query characters embedded for recall |
| `capture.timeoutMs` | `10000` | HTTP timeout for post-turn ingest and manual writes |
| `capture.maxCharsPerTurn` | `6000` | Maximum captured characters per turn |
| `capture.maxCharsPerMessage` | `3000` | Maximum captured characters per message |
| `capture.maxChunksPerTurn` | `4` | Maximum chunks sent to Persistio per turn |
| `capture.maxChunkChars` | `2000` | Maximum characters per capture chunk |
| `capture.roles.user` | `enabled` | Capture user messages |
| `capture.roles.assistant` | `bounded` | Capture assistant messages after deterministic noise filtering |
| `capture.roles.tool` | `disabled` | Capture tool messages |

## Upgrade from 0.1.x

Install the `0.2.x` package, configure `openclaw-persistio-v2`, and point the OpenClaw memory slot at the new plugin id:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-persistio-v2"
    }
  }
}
```

Keep the old `openclaw-persistio` entry disabled or remove it after confirming the new slot behaves correctly. The v2 id is intentionally distinct so operators opt into the new memory-slot behavior instead of silently changing an existing v1 install.

## Benchmark Posture

For behavioral benchmark work, leave `autoRecall=true` and `autoCapture=true`, keep recall under a tight timeout, and keep `includePending` / `includeRelated` off unless the specific benchmark requires them.

The expected turn shape is:

```text
OpenClaw turn
  -> Persistio autoRecall, bounded and fail-open
  -> model answers with a tiny memory block
  -> Persistio autoCapture, async and non-blocking
```
