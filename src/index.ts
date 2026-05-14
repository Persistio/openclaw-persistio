import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from 'openclaw/plugin-sdk/memory-core-host-engine-storage';
import { Type } from '@sinclair/typebox';
import { PersistioClient, type PersistioConfig, type PersistioMemory, type RecallBundle } from './client.js';

type OpenClawMessageRole = 'user' | 'assistant' | 'tool';

interface SessionMessageKeyStore {
  keys: Set<string>;
  lastSeen: number;
}

const DEFAULT_SEND_ROLES: PersistioConfig['send']['roles'] = {
  user: 'enabled',
  agent: 'enabled',
  tool: 'disabled',
};

const MESSAGE_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_SESSIONS = 250;
const MAX_SENT_KEYS_PER_SESSION = 2000;

function resolveSendConfig(raw: Record<string, unknown>): PersistioConfig['send'] {
  const send = raw['send'];
  const roles = typeof send === 'object' && send !== null
    ? (send as Record<string, unknown>)['roles']
    : undefined;
  const rawRoles = typeof roles === 'object' && roles !== null
    ? roles as Record<string, unknown>
    : {};

  return {
    roles: {
      user: rawRoles['user'] === 'disabled' ? 'disabled' : DEFAULT_SEND_ROLES.user,
      agent: rawRoles['agent'] === 'disabled' ? 'disabled' : DEFAULT_SEND_ROLES.agent,
      tool: rawRoles['tool'] === 'enabled' ? 'enabled' : DEFAULT_SEND_ROLES.tool,
    },
  };
}

function resolveConfig(raw: unknown): PersistioConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    baseURL: typeof c['baseURL'] === 'string' ? c['baseURL'] : '',
    apiKey: typeof c['apiKey'] === 'string' ? c['apiKey'] : '',
    tokenBudget: typeof c['tokenBudget'] === 'number' ? c['tokenBudget'] : 2000,
    recallTopK: typeof c['recallTopK'] === 'number' ? c['recallTopK'] : 10,
    recallTimeout: typeof c['recallTimeout'] === 'number' ? c['recallTimeout'] : 5000,
    send: resolveSendConfig(c),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function detectTaskType(text: string): 'troubleshooting' | 'coding' | 'planning' | 'writing' | 'general' {
  const normalized = text.toLowerCase();
  if (/(error|bug|fail|failing|issue|broken|debug|debugging|trace|stack)/.test(normalized)) {
    return 'troubleshooting';
  }
  if (/(code|coding|typescript|javascript|python|implement|refactor|function|class|api|build|test)/.test(normalized)) {
    return 'coding';
  }
  if (/(plan|planning|roadmap|strategy|steps|milestone|timeline|organize)/.test(normalized)) {
    return 'planning';
  }
  if (/(write|writing|draft|edit|copy|blog|essay|summary|summarize|document)/.test(normalized)) {
    return 'writing';
  }
  return 'general';
}

function buildRecallQuery(event: { prompt?: string; messages?: unknown[] }): string {
  const relevantMessages = Array.isArray(event.messages)
    ? event.messages
        .map((msg) => {
          if (typeof msg !== 'object' || msg === null) return null;
          const m = msg as Record<string, unknown>;
          const role = m['role'];
          if (role !== 'user' && role !== 'assistant') return null;
          const text = extractTextFromMessage(msg);
          if (!text) return null;
          return { role, text: text.replace(/\s+/g, ' ').trim() };
        })
        .filter((msg): msg is { role: 'user' | 'assistant'; text: string } => msg !== null && msg.text.length > 0)
    : [];

  const lastUserIndex = (() => {
    for (let i = relevantMessages.length - 1; i >= 0; i -= 1) {
      if (relevantMessages[i]!.role === 'user') return i;
    }
    return -1;
  })();

  const lastUserMessage = lastUserIndex >= 0
    ? relevantMessages[lastUserIndex]!.text
    : event.prompt?.replace(/\s+/g, ' ').trim() || 'recent context';
  const primary = truncate(lastUserMessage, 300);

  const contextStart = Math.max(0, lastUserIndex - 6);
  const contextMessages = lastUserIndex >= 0
    ? relevantMessages.slice(contextStart, lastUserIndex)
    : relevantMessages.slice(-6);
  const contextSummary = truncate(
    contextMessages
      .map((msg) => `${msg.role === 'user' ? 'U' : 'A'}:${msg.text}`)
      .join(' | '),
    200,
  );

  const taskType = detectTaskType(`${primary} ${event.prompt ?? ''}`);
  const parts = [primary];
  if (contextSummary.length > 0) parts.push(`Context: ${contextSummary}`);
  parts.push(`[task: ${taskType}]`);
  return truncate(parts.join('\n'), 600);
}

function buildMemoryBlock(bundle: RecallBundle, budget: number): string {
  const sections: Array<{ title: string; items: string[] }> = [
    { title: 'Behavioural rules', items: bundle.user_rules },
    { title: 'Preferences', items: bundle.user_preferences },
    { title: 'Task patterns', items: bundle.task_patterns },
    { title: 'Workflows', items: bundle.workflows },
    { title: 'Project', items: bundle.project },
    { title: 'Constraints', items: bundle.constraints },
    { title: 'Decisions', items: bundle.decisions },
    { title: 'System facts', items: bundle.system_facts },
    { title: 'Domain knowledge', items: bundle.domain_knowledge },
  ];

  const intro = 'Use the following as prior context and preferences. If they conflict with current instructions, follow the current instructions.';
  const lines: string[] = [intro];
  let used = estimateTokens(intro);

  for (const section of sections) {
    const candidates = section.items.filter((item) => item.trim().length > 0);
    if (candidates.length === 0) continue;

    const header = `## ${section.title}`;
    const tentativeLines = [...lines, '', header];
    let tentativeUsed = used + estimateTokens(`\n\n${header}`);
    const includedItems: string[] = [];

    for (const item of candidates) {
      const line = `- ${item}`;
      const cost = estimateTokens(`\n${line}`);
      if (tentativeUsed + cost > budget) {
        return lines.length > 1 ? lines.join('\n') : '';
      }
      includedItems.push(line);
      tentativeUsed += cost;
    }

    if (includedItems.length > 0) {
      tentativeLines.push(...includedItems);
      lines.splice(0, lines.length, ...tentativeLines);
      used = tentativeUsed;
    }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

function normalizeRole(role: unknown): OpenClawMessageRole | null {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role;
  return null;
}

function shouldSendRole(role: OpenClawMessageRole, config: PersistioConfig): boolean {
  if (role === 'assistant') return config.send.roles.agent === 'enabled';
  return config.send.roles[role] === 'enabled';
}

/** Extract plain text from a pi-agent-core message content array */
function extractTextFromMessage(msg: unknown, allowedRoles: OpenClawMessageRole[] = ['user', 'assistant']): string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const role = normalizeRole(m['role']);
  if (!role || !allowedRoles.includes(role)) return null;
  const content = m['content'];
  if (!Array.isArray(content)) {
    // Some messages have content as a plain string
    if (typeof content === 'string' && content.length > 0) return content;
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].length > 0) {
        parts.push(b['text']);
      }
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function resolveMessageTimestamp(msg: Record<string, unknown>): string | null {
  if (typeof msg['timestamp'] === 'number') return new Date(msg['timestamp']).toISOString();
  if (typeof msg['timestamp'] === 'string') return msg['timestamp'];
  return null;
}

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function buildMessageFingerprint(params: {
  sessionId: string;
  msg: Record<string, unknown>;
  role: OpenClawMessageRole;
  text: string;
  index: number;
}): string {
  const id = params.msg['id'];
  if (typeof id === 'string' && id.length > 0) {
    return `id:${params.sessionId}:${id}`;
  }

  const idempotencyKey = params.msg['idempotencyKey'];
  if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
    return `idempotency:${params.sessionId}:${idempotencyKey}`;
  }

  const timestamp = resolveMessageTimestamp(params.msg);
  const basis = timestamp ?? `index:${params.index}`;
  return `content:${params.sessionId}:${basis}:${params.role}:${hashString(params.text)}`;
}

function pruneSessionKeyStores(stores: Map<string, SessionMessageKeyStore>, now: number): void {
  for (const [sessionId, store] of stores) {
    if (now - store.lastSeen > MESSAGE_KEY_TTL_MS) stores.delete(sessionId);
  }

  while (stores.size > MAX_TRACKED_SESSIONS) {
    const oldest = [...stores.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (!oldest) return;
    stores.delete(oldest[0]);
  }
}

function getSessionKeyStore(stores: Map<string, SessionMessageKeyStore>, sessionId: string, now: number): Set<string> {
  pruneSessionKeyStores(stores, now);
  const existing = stores.get(sessionId);
  if (existing) {
    existing.lastSeen = now;
    return existing.keys;
  }

  const created: SessionMessageKeyStore = { keys: new Set(), lastSeen: now };
  stores.set(sessionId, created);
  return created.keys;
}

function rememberKeys(target: Set<string>, keys: string[], limit = Number.POSITIVE_INFINITY): void {
  for (const key of keys) {
    target.add(key);
    while (target.size > limit) {
      const oldest = target.values().next().value as string | undefined;
      if (!oldest) break;
      target.delete(oldest);
    }
  }
}

function forgetKeys(target: Set<string>, keys: string[]): void {
  for (const key of keys) target.delete(key);
}

const PERSISTIO_MEMORY_PATH_PREFIX = 'persistio://memory/';

function createClient(config: PersistioConfig, recallTopK = config.recallTopK): PersistioClient {
  return new PersistioClient({ ...config, recallTopK });
}

function normalizeMemoryScore(memory: PersistioMemory): number {
  if (typeof memory.similarity === 'number' && Number.isFinite(memory.similarity)) {
    return memory.similarity;
  }
  if (Number.isFinite(memory.confidence)) {
    return memory.confidence > 1 ? memory.confidence / 100 : memory.confidence;
  }
  return 0;
}

function buildMemoryPath(id: string): string {
  return `${PERSISTIO_MEMORY_PATH_PREFIX}${id}`;
}

function parseMemoryPath(relPath: string): string | null {
  return relPath.startsWith(PERSISTIO_MEMORY_PATH_PREFIX)
    ? relPath.slice(PERSISTIO_MEMORY_PATH_PREFIX.length)
    : null;
}

function formatMemoryDocument(memory: PersistioMemory): string {
  const lines = [
    `Subject: ${memory.subject}`,
    `Memory ID: ${memory.id}`,
    `Confidence: ${memory.confidence}`,
  ];

  if (memory.categories.length > 0) {
    lines.push(`Categories: ${memory.categories.join(', ')}`);
  }

  lines.push('', memory.data);
  return lines.join('\n');
}

async function probePersistio(client: PersistioClient): Promise<MemoryEmbeddingProbeResult> {
  try {
    await client.recall('__openclaw_probe__');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function createMemorySearchManager(config: PersistioConfig): MemorySearchManager {
  const client = createClient(config);

  return {
    async search(
      query: string,
      opts?: {
        maxResults?: number;
        minScore?: number;
        sessionKey?: string;
        qmdSearchModeOverride?: 'query' | 'search' | 'vsearch';
        onDebug?: (debug: unknown) => void;
        sources?: Array<'memory' | 'sessions'>;
      },
    ) {
      if (opts?.sources && !opts.sources.includes('memory')) {
        return [];
      }

      const recallTopK = typeof opts?.maxResults === 'number' ? opts.maxResults : config.recallTopK;
      const recallClient = createClient(config, recallTopK);
      const memories = await recallClient.recall(query);

      return memories
        .map((memory): MemorySearchResult => {
          const score = normalizeMemoryScore(memory);
          return {
            path: buildMemoryPath(memory.id),
            startLine: 1,
            endLine: 1,
            score,
            vectorScore: typeof memory.similarity === 'number' ? memory.similarity : undefined,
            snippet: truncate(memory.data, 400),
            source: 'memory',
            citation: memory.subject,
          };
        })
        .filter((result) => opts?.minScore === undefined || result.score >= opts.minScore);
    },

    async readFile(params: {
      relPath: string;
      from?: number;
      lines?: number;
    }) {
      const memoryId = parseMemoryPath(params.relPath);
      if (!memoryId) {
        throw new Error(`Unsupported Persistio memory path: ${params.relPath}`);
      }

      const memories = await client.listMemories();
      const memory = memories.find((item) => item.id === memoryId);
      if (!memory) {
        throw new Error(`Persistio memory not found: ${memoryId}`);
      }

      const text = formatMemoryDocument(memory);
      return {
        path: params.relPath,
        text,
        truncated: false,
        from: params.from ?? 1,
        lines: params.lines,
      };
    },

    status(): MemoryProviderStatus {
      return {
        backend: 'builtin',
        provider: 'persistio',
        sources: ['memory'],
        vector: {
          enabled: true,
        },
        custom: {
          baseURL: config.baseURL,
        },
      };
    },

    async probeEmbeddingAvailability() {
      return probePersistio(client);
    },

    async probeVectorAvailability() {
      const probe = await probePersistio(client);
      return probe.ok;
    },
  };
}

function createMemoryRuntime(config: PersistioConfig) {
  return {
    async getMemorySearchManager() {
      return {
        manager: createMemorySearchManager(config),
      };
    },

    resolveMemoryBackendConfig() {
      return { backend: 'builtin' as const };
    },
  };
}

export default definePluginEntry({
  id: 'openclaw-persistio',
  name: 'Persistio Memory',
  description: 'Persistent semantic memory for OpenClaw via Persistio',

  register(api) {
    const cfg = resolveConfig(api.pluginConfig);

    if (!cfg.baseURL || !cfg.apiKey) {
      api.logger?.warn?.('openclaw-persistio: baseURL and apiKey are required. Plugin disabled.');
      return;
    }

    const client = createClient(cfg);
    const sentMessageKeysBySession = new Map<string, SessionMessageKeyStore>();
    const pendingMessageKeysBySession = new Map<string, SessionMessageKeyStore>();
    api.registerMemoryCapability({
      runtime: createMemoryRuntime(cfg),
    });

    // -------------------------------------------------------------------------
    // before_prompt_build — recall relevant memories and inject into context
    // Event: { prompt: string, messages: unknown[] }
    // Return: { appendSystemContext?: string }
    // -------------------------------------------------------------------------
    api.on('before_prompt_build', async (event) => {
      try {
        const query = buildRecallQuery(event);
        const bundle = await client.recallBundle(query);
        const block = buildMemoryBlock(bundle, cfg.tokenBudget);
        if (!block) return;
        return { appendSystemContext: block };
      } catch (err) {
        api.logger?.warn?.(`openclaw-persistio: recall error: ${String(err)}`);
      }
    });

    // -------------------------------------------------------------------------
    // agent_end — ingest new turn messages (fire and forget)
    // Event: { runId?, messages: unknown[], success: boolean, error?, durationMs? }
    // Observation only — no return value.
    // -------------------------------------------------------------------------
    api.on('agent_end', async (event, context) => {
      try {
        const sessionId = context?.sessionId ?? event.runId ?? 'unknown-session';
        if (sessionId.startsWith('announce:')) return;
        const chunks: Array<{ role: string; content: string; timestamp: string }> = [];
        const chunkKeys: string[] = [];
        const now = Date.now();
        const sentKeys = getSessionKeyStore(sentMessageKeysBySession, sessionId, now);
        const pendingKeys = getSessionKeyStore(pendingMessageKeysBySession, sessionId, now);

        for (const [index, msg] of event.messages.entries()) {
          const m = msg as Record<string, unknown>;
          const role = normalizeRole(m['role']);
          if (!role || !shouldSendRole(role, cfg)) continue;
          const text = extractTextFromMessage(msg, ['user', 'assistant', 'tool']);
          if (!text || text.length === 0) continue;

          const key = buildMessageFingerprint({ sessionId, msg: m, role, text, index });
          if (sentKeys.has(key) || pendingKeys.has(key)) continue;

          const ts = resolveMessageTimestamp(m) ?? new Date().toISOString();
          chunkKeys.push(key);
          chunks.push({ role, content: text, timestamp: ts });
        }

        if (chunks.length === 0) return;
        rememberKeys(pendingKeys, chunkKeys);
        client.ingest(sessionId, chunks)
          .then(() => {
            rememberKeys(sentKeys, chunkKeys, MAX_SENT_KEYS_PER_SESSION);
          })
          .catch((err: unknown) => {
            api.logger?.warn?.(`openclaw-persistio: ingest error: ${String(err)}`);
          })
          .finally(() => {
            forgetKeys(pendingKeys, chunkKeys);
          });
      } catch (err) {
        api.logger?.warn?.(`openclaw-persistio: agent_end error: ${String(err)}`);
      }
    });

    // -------------------------------------------------------------------------
    // Tools
    // Verified signature: api.registerTool({ name, description, parameters, execute }, opts?)
    // execute(_id: string, params: unknown): Promise<AgentToolResult>
    // AgentToolResult: { content: Array<{ type: "text", text: string }>, details: unknown }
    // -------------------------------------------------------------------------

    api.registerTool({
      name: 'memory_search',
      label: 'Search Memory',
      description: 'Search persistent memory for relevant facts from past conversations.',
      parameters: Type.Object({
        query: Type.String({ description: 'What to search for' }),
        top_k: Type.Optional(Type.Number({ description: 'Max results to return' })),
      }),
      async execute(_id, params) {
        const p = params as { query: string; top_k?: number };
        const overrideTopK = typeof p.top_k === 'number' ? p.top_k : cfg.recallTopK;
        const overrideCfg = { ...cfg, recallTopK: overrideTopK };
        const c = new PersistioClient(overrideCfg);
        const memories = await c.recall(p.query);
        const text = memories.length > 0
          ? memories.map(m => `- ${m.data} [${m.subject}]`).join('\n')
          : 'No memories found.';
        return { content: [{ type: 'text' as const, text }], details: null };
      },
    });

    api.registerTool({
      name: 'memory_add',
      label: 'Add Memory',
      description: 'Manually store a fact in persistent memory.',
      parameters: Type.Object({
        data: Type.String({ description: 'The fact to remember' }),
        subject: Type.String({ description: 'The entity or topic this fact is about' }),
      }),
      async execute(_id, params) {
        const p = params as { data: string; subject: string };
        await client.addMemory(p.data, p.subject);
        return { content: [{ type: 'text' as const, text: 'Memory stored.' }], details: null };
      },
    });

    api.registerTool({
      name: 'memory_delete',
      label: 'Delete Memory',
      description: 'Delete a specific memory by its ID.',
      parameters: Type.Object({
        id: Type.String({ description: 'The memory ID to delete' }),
      }),
      async execute(_id, params) {
        const p = params as { id: string };
        await client.deleteMemory(p.id);
        return { content: [{ type: 'text' as const, text: 'Memory deleted.' }], details: null };
      },
    }, { optional: true });

    api.registerTool({
      name: 'memory_list',
      label: 'List Memories',
      description: 'List all stored memories.',
      parameters: Type.Object({}),
      async execute(_id, _params) {
        const memories = await client.listMemories();
        const text = memories.length > 0
          ? memories.map(m => `[${m.id}] ${m.data} (${m.subject})`).join('\n')
          : 'No memories stored.';
        return { content: [{ type: 'text' as const, text }], details: null };
      },
    }, { optional: true });
  },
});
