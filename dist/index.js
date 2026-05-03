import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { Type } from '@sinclair/typebox';
import { PersistioClient } from './client.js';
function resolveConfig(raw) {
    const c = (raw ?? {});
    return {
        baseURL: typeof c['baseURL'] === 'string' ? c['baseURL'] : '',
        apiKey: typeof c['apiKey'] === 'string' ? c['apiKey'] : '',
        tokenBudget: typeof c['tokenBudget'] === 'number' ? c['tokenBudget'] : 2000,
        recallTopK: typeof c['recallTopK'] === 'number' ? c['recallTopK'] : 10,
        recallTimeout: typeof c['recallTimeout'] === 'number' ? c['recallTimeout'] : 5000,
    };
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function buildMemoryBlock(memories, budget) {
    if (memories.length === 0)
        return '';
    const lines = ['## Relevant memories from past conversations'];
    let used = estimateTokens(lines[0]);
    for (const m of memories) {
        const line = `- ${m.data} [${m.subject}]`;
        const cost = estimateTokens(line);
        if (used + cost > budget)
            break;
        lines.push(line);
        used += cost;
    }
    return lines.length > 1 ? lines.join('\n') : '';
}
/** Extract plain text from a pi-agent-core message content array */
function extractTextFromMessage(msg) {
    if (typeof msg !== 'object' || msg === null)
        return null;
    const m = msg;
    const role = m['role'];
    if (role !== 'user' && role !== 'assistant')
        return null;
    const content = m['content'];
    if (!Array.isArray(content)) {
        // Some messages have content as a plain string
        if (typeof content === 'string' && content.length > 0)
            return content;
        return null;
    }
    const parts = [];
    for (const block of content) {
        if (typeof block === 'object' && block !== null) {
            const b = block;
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
                // Use the current prompt as the recall query
                const query = event.prompt?.slice(0, 500) || 'recent context';
                const memories = await client.recall(query);
                if (memories.length === 0)
                    return;
                const block = buildMemoryBlock(memories, cfg.tokenBudget);
                if (!block)
                    return;
                return { appendSystemContext: block };
            }
            catch (err) {
                api.logger?.warn?.(`openclaw-persistio: recall error: ${String(err)}`);
            }
        });
        // -------------------------------------------------------------------------
        // agent_end — ingest new turn messages (fire and forget)
        // Event: { runId?, messages: unknown[], success: boolean, error?, durationMs? }
        // Observation only — no return value.
        // -------------------------------------------------------------------------
        api.on('agent_end', async (event) => {
            try {
                const sessionId = event.runId ?? 'unknown-session';
                const chunks = [];
                for (const msg of event.messages) {
                    const m = msg;
                    const role = m['role'];
                    if (role !== 'user' && role !== 'assistant')
                        continue;
                    const text = extractTextFromMessage(msg);
                    if (text && text.length > 0) {
                        chunks.push({ role: role, content: text });
                    }
                }
                if (chunks.length === 0)
                    return;
                // Fire and forget — agent_end is async but result is ignored
                client.ingest(sessionId, chunks).catch((err) => {
                    api.logger?.warn?.(`openclaw-persistio: ingest error: ${String(err)}`);
                });
            }
            catch (err) {
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
                const p = params;
                const overrideTopK = typeof p.top_k === 'number' ? p.top_k : cfg.recallTopK;
                const overrideCfg = { ...cfg, recallTopK: overrideTopK };
                const c = new PersistioClient(overrideCfg);
                const memories = await c.recall(p.query);
                const text = memories.length > 0
                    ? memories.map(m => `- ${m.data} [${m.subject}]`).join('\n')
                    : 'No memories found.';
                return { content: [{ type: 'text', text }], details: null };
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
                const p = params;
                await client.addMemory(p.data, p.subject);
                return { content: [{ type: 'text', text: 'Memory stored.' }], details: null };
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
                const p = params;
                await client.deleteMemory(p.id);
                return { content: [{ type: 'text', text: 'Memory deleted.' }], details: null };
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
                return { content: [{ type: 'text', text }], details: null };
            },
        }, { optional: true });
    },
});
