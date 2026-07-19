import { Type } from '@sinclair/typebox';
import { PersistioClient, PersistioTimeoutError } from './client.js';
import { prepareCapture } from './capture.js';
import { resolveConfig } from './config.js';
import { buildMemoryBlock, buildRecallQuery } from './memory-format.js';
const emptyPluginConfigSchema = {
    safeParse(value) {
        if (value === undefined)
            return { success: true, data: undefined };
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { success: false, error: { message: 'expected config object' } };
        }
        if (Object.keys(value).length > 0) {
            return { success: false, error: { message: 'config must be empty' } };
        }
        return { success: true, data: value };
    },
    jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
    },
};
const CAPTURE_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CAPTURED_KEYS = 2000;
const MAX_CAPTURE_STORES = 250;
const RECALL_GUARD_MARGIN_MS = 250;
const RECALL_FAILURE_THRESHOLD = 3;
const RECALL_COOLDOWN_MS = 60_000;
class CircuitBreaker {
    failures = 0;
    openedUntil = 0;
    canAttempt(now = Date.now()) {
        return now >= this.openedUntil;
    }
    recordSuccess() {
        this.failures = 0;
        this.openedUntil = 0;
    }
    recordFailure(now = Date.now()) {
        this.failures += 1;
        if (this.failures >= RECALL_FAILURE_THRESHOLD) {
            this.openedUntil = now + RECALL_COOLDOWN_MS;
            return true;
        }
        return false;
    }
    remainingMs(now = Date.now()) {
        return Math.max(0, this.openedUntil - now);
    }
}
class CaptureKeyStore {
    capturedKeys = new Map();
    pendingKeys = new Map();
    lastSeen = Date.now();
    has(key, now = Date.now()) {
        this.prune(now);
        return this.capturedKeys.has(key) || this.pendingKeys.has(key);
    }
    markPending(keys, now = Date.now()) {
        this.prune(now);
        this.lastSeen = now;
        for (const key of keys) {
            this.pendingKeys.set(key, now);
        }
    }
    markCaptured(keys, now = Date.now()) {
        this.prune(now);
        this.lastSeen = now;
        for (const key of keys) {
            this.pendingKeys.delete(key);
            this.capturedKeys.set(key, now);
            while (this.capturedKeys.size > MAX_CAPTURED_KEYS) {
                const oldest = this.capturedKeys.keys().next().value;
                if (!oldest)
                    break;
                this.capturedKeys.delete(oldest);
            }
        }
    }
    releasePending(keys, now = Date.now()) {
        this.prune(now);
        this.lastSeen = now;
        for (const key of keys) {
            this.pendingKeys.delete(key);
        }
    }
    isExpired(now = Date.now()) {
        this.prune(now);
        return this.capturedKeys.size === 0
            && this.pendingKeys.size === 0
            && now - this.lastSeen > CAPTURE_KEY_TTL_MS;
    }
    getLastSeen() {
        return this.lastSeen;
    }
    hasPending(now = Date.now()) {
        this.prune(now);
        return this.pendingKeys.size > 0;
    }
    prune(now) {
        for (const [key, timestamp] of this.capturedKeys.entries()) {
            if (now - timestamp > CAPTURE_KEY_TTL_MS)
                this.capturedKeys.delete(key);
        }
        for (const [key, timestamp] of this.pendingKeys.entries()) {
            if (now - timestamp > CAPTURE_KEY_TTL_MS)
                this.pendingKeys.delete(key);
        }
    }
}
function jsonResult(payload) {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        details: payload,
    };
}
function textResult(text, details = null) {
    return {
        content: [{ type: 'text', text }],
        details,
    };
}
async function guardedRecall(params) {
    return (await guardedRecallOutcome(params)).value;
}
async function guardedRecallOutcome(params) {
    const now = Date.now();
    if (!params.breaker.canAttempt(now)) {
        const unavailable = `Persistio recall unavailable; circuit breaker open for ${params.breaker.remainingMs(now)}ms`;
        params.logger?.warn?.(`openclaw-persistio-v2: ${params.operation} skipped; ${unavailable}`);
        return { value: params.fallback, unavailable };
    }
    try {
        const result = await params.run();
        params.breaker.recordSuccess();
        return { value: result };
    }
    catch (err) {
        const opened = params.breaker.recordFailure();
        const unavailable = `Persistio recall unavailable during ${params.operation}: ${String(err)}`;
        params.logger?.warn?.(`openclaw-persistio-v2: ${params.operation} failed open: ${String(err)}`
            + (opened ? `; recall circuit breaker open for ${RECALL_COOLDOWN_MS}ms` : ''));
        return { value: params.fallback, unavailable };
    }
}
function pruneCaptureStores(stores, now = Date.now()) {
    for (const [sessionId, store] of stores.entries()) {
        if (store.isExpired(now))
            stores.delete(sessionId);
    }
    while (stores.size > MAX_CAPTURE_STORES) {
        let oldestSessionId;
        let oldestLastSeen = Number.POSITIVE_INFINITY;
        for (const [sessionId, store] of stores.entries()) {
            if (store.hasPending(now))
                continue;
            const lastSeen = store.getLastSeen();
            if (lastSeen < oldestLastSeen) {
                oldestLastSeen = lastSeen;
                oldestSessionId = sessionId;
            }
        }
        if (!oldestSessionId) {
            for (const [sessionId, store] of stores.entries()) {
                const lastSeen = store.getLastSeen();
                if (lastSeen < oldestLastSeen) {
                    oldestLastSeen = lastSeen;
                    oldestSessionId = sessionId;
                }
            }
        }
        if (!oldestSessionId)
            break;
        stores.delete(oldestSessionId);
    }
}
function emptyRecallResult() {
    return { memories: [], relatedMemories: [] };
}
function serializeMemory(memory) {
    return {
        id: memory.id,
        subject: memory.subject,
        text: memory.data,
        similarity: memory.similarity,
        confidence: memory.confidence,
        categories: memory.categories ?? [],
    };
}
function formatRecallToolResult(result) {
    if (result.memories.length === 0 && result.relatedMemories.length === 0) {
        return jsonResult({ count: 0, memories: [], related_memories: [], provider: 'persistio' });
    }
    return jsonResult({
        count: result.memories.length,
        related_count: result.relatedMemories.length,
        provider: 'persistio',
        memories: result.memories.map(serializeMemory),
        related_memories: result.relatedMemories.map((memory) => ({
            ...serializeMemory(memory),
            edge_type: memory.edge_type ?? undefined,
        })),
    });
}
function formatUnavailableRecallResult(unavailable) {
    return jsonResult({
        count: 0,
        related_count: 0,
        memories: [],
        related_memories: [],
        provider: 'persistio',
        unavailable: true,
        warning: unavailable,
    });
}
function buildPromptGuidance({ availableTools }) {
    if (!availableTools.has('memory_recall'))
        return [];
    return [
        '## Persistio Memory',
        'Persistio provides durable behavioral memory. Use memory_recall when prior user preferences, decisions, project context, or past working style would materially improve the answer.',
        'Do not mention memory unless the user asks.',
        '',
    ];
}
function buildCaptureProvenance(sessionId, chunks) {
    const roles = countChunkRoles(chunks);
    const hasUser = (roles.get('user') ?? 0) > 0;
    const hasAssistant = (roles.get('assistant') ?? 0) > 0;
    const hasTool = (roles.get('tool') ?? 0) > 0;
    const hasHumanConversationShape = hasUser && hasAssistant;
    const hasGeneratedRole = hasAssistant || hasTool;
    const sourceClass = inferSourceClass(sessionId);
    const authorship = getAuthorshipFromRoles(hasUser, hasGeneratedRole);
    const actorType = getActorFromRoles(hasUser, hasAssistant, hasTool);
    const artifactType = getArtifactFromRoles(hasUser, hasAssistant, hasTool);
    if (sourceClass === 'agent_cron') {
        return provenance(sourceClass, hasUser ? actorType : hasTool && !hasAssistant ? 'tool' : 'agent', 'scheduled', hasUser ? artifactType : hasTool && !hasAssistant ? 'tool_result' : 'observation', hasUser ? authorship : 'generated', 'recurring', 0.99, ['session_id_prefix', 'agent_trigger', 'role_counts', 'plugin_capture']);
    }
    if (sourceClass === 'agent_hook') {
        return provenance(sourceClass, hasUser ? actorType : hasTool && !hasAssistant ? 'tool' : 'agent', 'event', hasUser ? artifactType : hasTool && !hasAssistant ? 'tool_result' : 'observation', hasUser ? authorship : 'generated', 'recurring', 0.95, ['session_id_prefix', 'agent_trigger', 'role_counts', 'plugin_capture']);
    }
    if (sourceClass === 'agent_subagent' || sourceClass === 'agent_other') {
        return provenance(sourceClass, hasUser ? actorType : hasTool && !hasAssistant ? 'tool' : 'agent', 'delegated', artifactType, hasUser ? authorship : 'generated', 'one_off', 0.9, ['session_id_prefix', 'agent_trigger', 'role_counts', 'plugin_capture']);
    }
    if (sourceClass === 'agent_slack') {
        return provenance(sourceClass, hasUser ? 'human' : hasTool && !hasAssistant ? 'tool' : 'assistant', 'delegated', hasHumanConversationShape ? 'conversation' : artifactType, authorship, 'one_off', 0.9, ['session_id_prefix', 'integration_marker', 'role_counts', 'plugin_capture']);
    }
    if (sourceClass === 'thread_conversation') {
        return provenance(sourceClass, actorType, 'direct', hasHumanConversationShape ? 'conversation' : artifactType, authorship, 'one_off', hasUser ? 0.8 : 0.7, ['thread_session_shape', 'role_counts', 'plugin_capture']);
    }
    if (sourceClass === 'direct_or_import') {
        return provenance(sourceClass, actorType, 'api', hasHumanConversationShape ? 'conversation' : artifactType, authorship, 'one_off', 0.65, ['session_id_shape', 'role_counts', 'plugin_capture']);
    }
    return provenance(sourceClass, actorType, 'unknown', hasHumanConversationShape ? 'conversation' : artifactType, authorship, 'unknown', hasUser || hasGeneratedRole ? 0.5 : 0.25, ['role_counts', 'plugin_capture', 'fallback']);
}
function getAuthorshipFromRoles(hasUser, hasGeneratedRole) {
    if (hasUser && hasGeneratedRole)
        return 'mixed';
    if (hasUser)
        return 'original';
    if (hasGeneratedRole)
        return 'generated';
    return 'unknown';
}
function getActorFromRoles(hasUser, hasAssistant, hasTool) {
    if (hasUser)
        return 'human';
    if (hasTool && !hasAssistant)
        return 'tool';
    if (hasAssistant)
        return 'assistant';
    if (hasTool)
        return 'tool';
    return 'unknown';
}
function getArtifactFromRoles(hasUser, hasAssistant, hasTool) {
    if (hasUser && (hasAssistant || hasTool))
        return 'conversation';
    if (hasTool && !hasAssistant && !hasUser)
        return 'tool_result';
    if (hasUser || hasAssistant)
        return 'message';
    if (hasTool)
        return 'tool_result';
    return 'unknown';
}
function inferSourceClass(sessionId) {
    if (sessionId.startsWith('agent:')) {
        const trigger = sessionId.split(':')[2] ?? '';
        if (trigger === 'cron')
            return 'agent_cron';
        if (trigger === 'hook')
            return 'agent_hook';
        if (trigger === 'slack')
            return 'agent_slack';
        if (trigger === 'subagent')
            return 'agent_subagent';
        return 'agent_other';
    }
    if (sessionId.includes('-topic-'))
        return 'thread_conversation';
    if (/^[0-9a-f-]{36}$/i.test(sessionId))
        return 'direct_or_import';
    return 'unknown';
}
function countChunkRoles(chunks) {
    const counts = new Map();
    for (const chunk of chunks) {
        const role = String(chunk.role || 'unknown').toLowerCase();
        counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    return counts;
}
function provenance(sourceClass, actorType, triggerType, artifactType, authorship, cadence, confidence, basis) {
    return {
        source_class: sourceClass,
        actor_type: actorType,
        trigger_type: triggerType,
        artifact_type: artifactType,
        authorship,
        cadence,
        provenance_confidence: confidence,
        provenance_basis: basis,
    };
}
const plugin = {
    id: 'openclaw-persistio-v2',
    name: 'Persistio Memory v2',
    description: 'OpenClaw-native long-term memory powered by Persistio',
    configSchema: emptyPluginConfigSchema,
    register(api) {
        const cfg = resolveConfig(api.pluginConfig);
        if (!cfg.baseURL || !cfg.apiKey) {
            api.logger?.warn?.('openclaw-persistio-v2: baseURL and apiKey are required. Plugin disabled.');
            return;
        }
        const client = new PersistioClient(cfg);
        const recallBreaker = new CircuitBreaker();
        const capturedKeysBySession = new Map();
        api.registerMemoryCapability?.({
            promptBuilder: buildPromptGuidance,
        });
        api.registerTool({
            name: 'memory_recall',
            label: 'Memory Recall',
            description: 'Recall relevant durable Persistio memories for user preferences, decisions, project context, and prior working style.',
            parameters: Type.Object({
                query: Type.String({ description: 'Search query' }),
                limit: Type.Optional(Type.Number({ description: 'Maximum memories to return' })),
            }, { additionalProperties: false }),
            async execute(_toolCallId, params) {
                const p = params;
                const query = typeof p.query === 'string' ? p.query.trim() : '';
                if (!query)
                    return jsonResult({ count: 0, memories: [], error: 'memory_recall requires a query' });
                const limit = typeof p.limit === 'number' && Number.isFinite(p.limit)
                    ? Math.max(1, Math.min(8, Math.floor(p.limit)))
                    : cfg.recall.maxResults;
                const memories = await guardedRecallOutcome({
                    operation: 'memory_recall',
                    breaker: recallBreaker,
                    logger: api.logger,
                    fallback: emptyRecallResult(),
                    run: () => client.recall(query, { maxResults: limit }),
                });
                if (memories.unavailable)
                    return formatUnavailableRecallResult(memories.unavailable);
                return formatRecallToolResult(memories.value);
            },
        }, { name: 'memory_recall' });
        api.registerTool({
            name: 'memory_store',
            label: 'Memory Store',
            description: 'Store a deliberate durable fact, preference, decision, or project note in Persistio memory.',
            parameters: Type.Object({
                text: Type.String({ description: 'Durable information to remember' }),
                subject: Type.String({ description: 'Entity, project, person, or topic this memory is about' }),
            }, { additionalProperties: false }),
            async execute(_toolCallId, params) {
                const p = params;
                const text = typeof p.text === 'string' ? p.text.trim() : '';
                const subject = typeof p.subject === 'string' ? p.subject.trim() : '';
                if (!text || !subject)
                    return jsonResult({ stored: false, error: 'memory_store requires text and subject' });
                try {
                    const memory = await client.storeMemory(text, subject);
                    return textResult('Memory stored.', { stored: true, id: memory.id });
                }
                catch (err) {
                    if (err instanceof PersistioTimeoutError) {
                        return textResult('Memory store timed out; Persistio may still have stored it. Do not retry automatically.', { stored: 'unknown', ambiguous: true, timeoutMs: cfg.capture.timeoutMs });
                    }
                    throw err;
                }
            },
        }, { name: 'memory_store' });
        api.registerTool({
            name: 'memory_forget',
            label: 'Memory Forget',
            description: 'Forget a Persistio memory by id, or search candidates to forget by query.',
            parameters: Type.Object({
                id: Type.Optional(Type.String({ description: 'Persistio memory id to delete' })),
                query: Type.Optional(Type.String({ description: 'Search query to find candidate memories' })),
            }, { additionalProperties: false }),
            async execute(_toolCallId, params) {
                const p = params;
                const id = typeof p.id === 'string' ? p.id.trim() : '';
                if (id) {
                    await client.forgetMemory(id);
                    return textResult('Memory forgotten.', { forgotten: true, id });
                }
                const query = typeof p.query === 'string' ? p.query.trim() : '';
                if (!query)
                    return jsonResult({ forgotten: false, error: 'memory_forget requires id or query' });
                const memories = await guardedRecallOutcome({
                    operation: 'memory_forget candidates',
                    breaker: recallBreaker,
                    logger: api.logger,
                    fallback: emptyRecallResult(),
                    run: () => client.recall(query, { maxResults: 5 }),
                });
                if (memories.unavailable) {
                    return jsonResult({
                        forgotten: false,
                        unavailable: true,
                        warning: memories.unavailable,
                        candidates: [],
                        related_candidates: [],
                    });
                }
                return jsonResult({
                    forgotten: false,
                    candidates: memories.value.memories.map((memory) => ({
                        id: memory.id,
                        subject: memory.subject,
                        text: memory.data,
                        similarity: memory.similarity,
                    })),
                    related_candidates: memories.value.relatedMemories.map((memory) => ({
                        id: memory.id,
                        subject: memory.subject,
                        text: memory.data,
                        edge_type: memory.edge_type ?? undefined,
                    })),
                });
            },
        }, { name: 'memory_forget' });
        api.on('before_prompt_build', async (event) => {
            if (!cfg.autoRecall)
                return;
            const query = buildRecallQuery(event, cfg.recall.queryMaxChars);
            if (!query)
                return;
            const block = await guardedRecall({
                operation: 'autoRecall',
                breaker: recallBreaker,
                logger: api.logger,
                fallback: '',
                run: async () => {
                    const response = await client.recallBundle(query);
                    return buildMemoryBlock(response.bundle, cfg.recall.tokenBudget, response.related_bundle);
                },
            });
            if (!block)
                return;
            return { prependContext: block };
        }, { timeoutMs: cfg.recall.timeoutMs + RECALL_GUARD_MARGIN_MS });
        api.on('agent_end', (event, context) => {
            if (!cfg.autoCapture || event.success === false)
                return;
            const sessionId = context?.sessionKey ?? context?.sessionId ?? event.runId ?? 'unknown-session';
            const now = Date.now();
            pruneCaptureStores(capturedKeysBySession, now);
            const store = capturedKeysBySession.get(sessionId) ?? new CaptureKeyStore();
            capturedKeysBySession.set(sessionId, store);
            const prepared = prepareCapture(event, cfg, {
                shouldIncludeKey: (key) => !store.has(key, now),
            });
            if (prepared.chunks.length === 0)
                return;
            const provenance = buildCaptureProvenance(sessionId, prepared.chunks);
            const chunks = prepared.chunks.map((chunk) => ({ ...chunk, provenance }));
            store.markPending(prepared.keys, now);
            void client.ingest(sessionId, chunks)
                .then(() => {
                store.markCaptured(prepared.keys);
            })
                .catch((err) => {
                if (err instanceof PersistioTimeoutError) {
                    api.logger?.warn?.(`openclaw-persistio-v2: autoCapture timed out after ${cfg.capture.timeoutMs}ms`);
                    store.markCaptured(prepared.keys);
                    return;
                }
                store.releasePending(prepared.keys);
                api.logger?.warn?.(`openclaw-persistio-v2: autoCapture failed: ${String(err)}`);
            });
        });
        api.logger?.info?.('openclaw-persistio-v2: registered');
    },
};
export default plugin;
