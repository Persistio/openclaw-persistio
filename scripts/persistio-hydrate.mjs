#!/usr/bin/env node
/**
 * persistio-hydrate.js
 *
 * Hydrate a Persistio memory store from raw OpenClaw session JSONL files.
 * Replicates the exact extraction logic of the openclaw-persistio plugin.
 *
 * Usage:
 *   node persistio-hydrate.js --url <baseURL> --key <apiKey> --file <session.jsonl>
 *   node persistio-hydrate.js --url <baseURL> --key <apiKey> --dir <sessions-dir> [--limit 10]
 *
 * Options:
 *   --url     Persistio base URL (e.g. https://ca-persistio-prod.gentlesand-1ea7041a.uksouth.azurecontainerapps.io)
 *   --key     Tenant API key
 *   --file    Path to a single JSONL session file
 *   --dir     Path to a directory of JSONL session files (processes oldest first)
 *   --limit   Max number of files to process when using --dir (default: all)
 *   --dry-run Parse and show what would be sent, without sending
 *   --verbose Print each chunk as it's sent
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url:       { type: 'string' },
    key:       { type: 'string' },
    file:      { type: 'string' },
    dir:       { type: 'string' },
    limit:     { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    verbose:   { type: 'boolean', default: false },
  }
});

if (!args.url || !args.key || (!args.file && !args.dir)) {
  console.error('Usage: node persistio-hydrate.js --url <url> --key <apiKey> --file <file> | --dir <dir> [--limit N] [--dry-run] [--verbose]');
  process.exit(1);
}

const BASE_URL = args.url.replace(/\/$/, '');
const API_KEY  = args.key;
const DRY_RUN  = args['dry-run'];
const VERBOSE  = args.verbose;
const LIMIT    = args.limit ? parseInt(args.limit, 10) : Infinity;

/**
 * Extract plain text from a message content field.
 * Matches the plugin's extractTextFromMessage() exactly.
 */
function extractText(msg) {
  const role = msg?.role;
  if (role !== 'user' && role !== 'assistant') return null;

  const content = msg?.content;

  if (typeof content === 'string' && content.length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        parts.push(block.text);
      }
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  return null;
}

/**
 * Parse a JSONL session file and extract user/assistant chunks.
 */
async function parseSessionFile(filePath) {
  const chunks = [];
  const sessionId = path.basename(filePath, '.jsonl');

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    const text = extractText(msg);
    if (text) {
      chunks.push({ role: msg.role, content: text });
    }
  }

  return { sessionId, chunks };
}

/**
 * Ingest chunks into Persistio.
 */
async function ingest(sessionId, chunks) {
  const res = await fetch(`${BASE_URL}/v1/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({ session_id: sessionId, chunks })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ingest failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Get JSONL files from a directory, sorted oldest first.
 */
function getSessionFiles(dir, limit) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.reset.'))
    .map(f => ({
      name: f,
      fullPath: path.join(dir, f),
      mtime: fs.statSync(path.join(dir, f)).mtimeMs
    }))
    .sort((a, b) => a.mtime - b.mtime)
    .slice(0, limit)
    .map(f => f.fullPath);

  return files;
}

async function main() {
  const files = args.file
    ? [args.file]
    : getSessionFiles(args.dir, LIMIT);

  console.log(`📂 Processing ${files.length} session file(s)...`);
  if (DRY_RUN) console.log('🔍 DRY RUN — nothing will be sent\n');

  let totalChunks = 0;
  let totalSessions = 0;
  let skipped = 0;

  for (const filePath of files) {
    const { sessionId, chunks } = await parseSessionFile(filePath);

    if (chunks.length === 0) {
      if (VERBOSE) console.log(`⏭  ${sessionId} — no user/assistant messages, skipping`);
      skipped++;
      continue;
    }

    if (VERBOSE || DRY_RUN) {
      console.log(`📨 ${sessionId} — ${chunks.length} chunks`);
      if (DRY_RUN) {
        chunks.forEach((c, i) => console.log(`   [${i}] ${c.role}: ${c.content.slice(0, 80)}...`));
      }
    }

    if (!DRY_RUN) {
      try {
        await ingest(sessionId, chunks);
        totalChunks += chunks.length;
        totalSessions++;
        if (VERBOSE) console.log(`   ✅ ingested`);
      } catch (err) {
        console.error(`   ❌ ${sessionId}: ${err.message}`);
      }
    } else {
      totalChunks += chunks.length;
      totalSessions++;
    }
  }

  console.log(`\n✅ Done.`);
  console.log(`   Sessions processed : ${totalSessions}`);
  console.log(`   Chunks sent        : ${totalChunks}`);
  console.log(`   Skipped (empty)    : ${skipped}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
