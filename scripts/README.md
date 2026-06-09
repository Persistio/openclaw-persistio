# persistio-hydrate.mjs

Seed a Persistio memory store from existing OpenClaw session JSONL files.

Useful when you're setting up Persistio for the first time and want to bootstrap it with historical conversation context — rather than starting from a blank slate.

The script sends the same `/v1/ingest` payload shape that the OpenClaw plugin uses, so historical chunks enter Persistio through the normal extraction and curation pipeline.

---

## Usage

**Single file:**
```bash
node persistio-hydrate.mjs --url https://api.persistio.ai --key <apiKey> --file /path/to/session.jsonl
```

**Directory of sessions:**
```bash
node persistio-hydrate.mjs --url https://api.persistio.ai --key <apiKey> --dir ~/.openclaw/sessions/
```

**Limit how many files to process:**
```bash
node persistio-hydrate.mjs --url https://api.persistio.ai --key <apiKey> --dir ~/.openclaw/sessions/ --limit 50
```

**Dry run (preview without sending):**
```bash
node persistio-hydrate.mjs --url https://api.persistio.ai --key <apiKey> --dir ~/.openclaw/sessions/ --dry-run --verbose
```

---

## Options

| Flag | Required | Description |
|------|----------|-------------|
| `--url` | ✅ | Persistio base URL |
| `--key` | ✅ | Persistio vault API key |
| `--file` | ✅ (or `--dir`) | Path to a single JSONL session file |
| `--dir` | ✅ (or `--file`) | Directory of JSONL session files (processed oldest-first) |
| `--limit` | | Max number of files to process from `--dir` (default: all) |
| `--dry-run` | | Parse and preview what would be sent, without sending |
| `--verbose` | | Print each session and chunk as it's processed |

---

## Notes

- Files are processed oldest-first (by mtime) when using `--dir`
- Files containing `.reset.` in their name are skipped
- Empty sessions (no user/assistant messages) are silently skipped
- Each session is ingested as a single batch call to `/v1/ingest`
