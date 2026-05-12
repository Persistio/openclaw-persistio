import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { Type } from '@sinclair/typebox';
import { PersistioClient, type PersistioConfig, type RecallBundle } from './client.js';

function resolveConfig(raw: unknown): PersistioConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    baseURL: typeof c['baseURL'] === 'string' ? c['baseURL'] : '',
    apiKey: typeof c['apiKey'] === 'string' ? c['apiKey'] : '',
    tokenBudget: typeof c['tokenBudget'] === 'number' ? c['tokenBudget'] : 2000,
    recallTopK: typeof c['recallTopK'] === 'number' ? c['recallTopK'] : 10,
    recallTimeout: typeof c['recallTimeout'] === 'number' ? c['recallTimeout'] : 5000,
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

/** Extract plain text from a pi-agent-core message content array */
function extractTextFromMessage(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const role = m['role'];
  if (role !== 'user' && role !== 'assistant') return null;
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

    const client = new PersistioClient(cfg);

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
    api.on('agent_end', async (event, context?) => {
      try {
        const sessionId = context?.sessionId ?? event.runId ?? 'unknown-session';
        if (sessionId.startsWith('announce:')) return;
        const chunks: Array<{ role: string; content: string; timestamp: string }> = [];

        for (const msg of event.messages) {
          const m = msg as Record<string, unknown>;
          const role = m['role'];
          if (role !== 'user' && role !== 'assistant') continue;
          const text = extractTextFromMessage(msg);
          const ts = typeof m['timestamp'] === 'number'
            ? new Date(m['timestamp']).toISOString()
            : typeof m['timestamp'] === 'string'
              ? m['timestamp']
              : new Date().toISOString();
          if (text && text.length > 0) {
            chunks.push({ role: role as string, content: text, timestamp: ts });
          }
        }

        if (chunks.length === 0) return;
        // Fire and forget — agent_end is async but result is ignored
        client.ingest(sessionId, chunks).catch((err: unknown) => {
          api.logger?.warn?.(`openclaw-persistio: ingest error: ${String(err)}`);
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
