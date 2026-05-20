# @persistio/openclaw-plugin

OpenClaw plugin for [Persistio](https://persistio.ai) — persistent semantic memory for AI agents.

Hooks into OpenClaw's `before_prompt_build` and `agent_end` events to automatically recall relevant memories into every prompt and ingest new conversation turns after each run. Exposes `memory_search`, `memory_add`, `memory_delete`, and `memory_list` as agent tools.

## Requirements

- A running [Persistio](https://persistio.ai) instance (`api.persistio.ai` or self-hosted)
- OpenClaw `>=2026.3.24-beta.2`

## Installation

```bash
openclaw plugins install @persistio/openclaw-plugin
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

## Public X/Twitter Memory Workflow

Install [TweetClaw](https://github.com/Xquik-dev/tweetclaw) from [npm](https://www.npmjs.com/package/@xquik/tweetclaw) beside Persistio when an OpenClaw workspace needs public X/Twitter source capture. The [ClawHub page](https://clawhub.ai/plugins/@xquik/tweetclaw) is useful for browsing while its listing lags behind the npm release:

```bash
openclaw plugins install @xquik/tweetclaw
```

TweetClaw adds agent tools for scrape tweets, search tweets, search tweet replies, follower export, user lookup, media download, monitor tweets, webhooks, giveaway draws, and approval-gated post tweets or replies through Xquik. Use those results as source material, then store only concise memory records with `memory_add` or normal Persistio transcript capture.

Useful memory fields include the search query, capture date, tweet URLs or IDs, author handles, follower/export counts, a short summary, and the decision or follow-up action. Do not save raw timelines, private account material, direct messages, cookies, API keys, or exported files into long-term memory.

## License

MIT
