import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { Type } from '@sinclair/typebox';
import { PersistioClient } from './client.js';
import { prepareMessageForIngest, resolveIngestPolicy, shouldIngestSession, } from './ingest-policy.js';
const DEFAULT_SEND_ROLES = {
    user: 'enabled',
    agent: 'enabled',
    tool: 'disabled',
};
const MESSAGE_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_SESSIONS = 250;
const MAX_SENT_KEYS_PER_SESSION = 2000;
const RECALL_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const RECALL_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
const RECALL_GUARD_MARGIN_MS = 250;
const DEFAULT_TOKEN_BUDGET = 400;
const DEFAULT_RECALL_TOP_K = 4;
const DEFAULT_RECALL_TIMEOUT_MS = 1500;
const MAX_MEMORY_SEARCH_RESULTS = 8;
const MAX_PROMPT_MEMORY_ITEM_CHARS = 500;
const MAX_MEMORY_SNIPPET_CHARS = 360;
class RecallCircuitBreaker {
    consecutiveFailures = 0;
    openedUntil = 0;
    canAttempt(now = Date.now()) {
        return now >= this.openedUntil;
    }
    remainingMs(now = Date.now()) {
        return Math.max(0, this.openedUntil - now);
    }
    recordSuccess() {
        this.consecutiveFailures = 0;
        this.openedUntil = 0;
    }
    recordFailure(now = Date.now()) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= RECALL_CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
            this.openedUntil = now + RECALL_CIRCUIT_BREAKER_COOLDOWN_MS;
            return true;
        }
        return false;
    }
}
function resolveSendConfig(raw) {
    const send = raw['send'];
    const roles = typeof send === 'object' && send !== null
        ? send['roles']
        : undefined;
    const rawRoles = typeof roles === 'object' && roles !== null
        ? roles
        : {};
    return {
        roles: {
            user: rawRoles['user'] === 'disabled' ? 'disabled' : DEFAULT_SEND_ROLES.user,
            agent: rawRoles['agent'] === 'disabled' ? 'disabled' : DEFAULT_SEND_ROLES.agent,
            tool: rawRoles['tool'] === 'enabled' ? 'enabled' : DEFAULT_SEND_ROLES.tool,
        },
    };
}
function resolveRecallMinSimilarity(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : undefined;
}
function resolvePositiveInteger(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
        ? Math.floor(value)
        : fallback;
}
function resolveBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function resolveOptionalPositiveInteger(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
        ? Math.floor(value)
        : undefined;
}
function clampPositiveInteger(value, min, max) {
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function resolveConfig(raw) {
    const c = (raw ?? {});
    return {
        baseURL: typeof c['baseURL'] === 'string' ? c['baseURL'] : '',
        apiKey: typeof c['apiKey'] === 'string' ? c['apiKey'] : '',
        tokenBudget: resolvePositiveInteger(c['tokenBudget'], DEFAULT_TOKEN_BUDGET),
        recallTopK: resolvePositiveInteger(c['recallTopK'], DEFAULT_RECALL_TOP_K),
        recallMinSimilarity: resolveRecallMinSimilarity(c['recallMinSimilarity']),
        recallTimeout: resolvePositiveInteger(c['recallTimeout'], DEFAULT_RECALL_TIMEOUT_MS),
        recallIncludePending: resolveBoolean(c['recallIncludePending'], false),
        includeRelatedMemories: resolveBoolean(c['includeRelatedMemories'], false),
        ingest: resolveIngestPolicy(c['ingest']),
        send: resolveSendConfig(c),
    };
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function truncate(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
function detectTaskType(text) {
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
function buildRecallQuery(event) {
    const relevantMessages = Array.isArray(event.messages)
        ? event.messages
            .map((msg) => {
            if (typeof msg !== 'object' || msg === null)
                return null;
            const m = msg;
            const role = m['role'];
            if (role !== 'user' && role !== 'assistant')
                return null;
            const text = extractTextFromMessage(msg);
            if (!text)
                return null;
            return { role, text: text.replace(/\s+/g, ' ').trim() };
        })
            .filter((msg) => msg !== null && msg.text.length > 0)
        : [];
    const lastUserIndex = (() => {
        for (let i = relevantMessages.length - 1; i >= 0; i -= 1) {
            if (relevantMessages[i].role === 'user')
                return i;
        }
        return -1;
    })();
    const lastUserMessage = lastUserIndex >= 0
        ? relevantMessages[lastUserIndex].text
        : event.prompt?.replace(/\s+/g, ' ').trim() || 'recent context';
    const primary = truncate(lastUserMessage, 300);
    const contextStart = Math.max(0, lastUserIndex - 6);
    const contextMessages = lastUserIndex >= 0
        ? relevantMessages.slice(contextStart, lastUserIndex)
        : relevantMessages.slice(-6);
    const contextSummary = truncate(contextMessages
        .map((msg) => `${msg.role === 'user' ? 'U' : 'A'}:${msg.text}`)
        .join(' | '), 200);
    const taskType = detectTaskType(`${primary} ${event.prompt ?? ''}`);
    const parts = [primary];
    if (contextSummary.length > 0)
        parts.push(`Context: ${contextSummary}`);
    parts.push(`[task: ${taskType}]`);
    return truncate(parts.join('\n'), 600);
}
function toStringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string')
        : [];
}
function buildMemoryBlock(bundle, budget, relatedBundle) {
    if (!bundle || typeof bundle !== 'object')
        return '';
    const sections = [
        { title: 'Behavioural rules', items: [...toStringArray(bundle.global_user_rules), ...toStringArray(bundle.user_rules)] },
        { title: 'Preferences', items: toStringArray(bundle.user_preferences) },
        { title: 'Task patterns', items: toStringArray(bundle.task_patterns) },
        { title: 'Workflows', items: toStringArray(bundle.workflows) },
        { title: 'Project', items: toStringArray(bundle.project) },
        { title: 'Constraints', items: toStringArray(bundle.constraints) },
        { title: 'Decisions', items: toStringArray(bundle.decisions) },
        { title: 'System facts', items: toStringArray(bundle.system_facts) },
        { title: 'Domain knowledge', items: toStringArray(bundle.domain_knowledge) },
    ];
    if (relatedBundle && typeof relatedBundle === 'object') {
        sections.push({ title: 'Related behavioural rules', items: toStringArray(relatedBundle.user_rules) }, { title: 'Related preferences', items: toStringArray(relatedBundle.user_preferences) }, { title: 'Related task patterns', items: toStringArray(relatedBundle.task_patterns) }, { title: 'Related workflows', items: toStringArray(relatedBundle.workflows) }, { title: 'Related project', items: toStringArray(relatedBundle.project) }, { title: 'Related constraints', items: toStringArray(relatedBundle.constraints) }, { title: 'Related decisions', items: toStringArray(relatedBundle.decisions) }, { title: 'Related system facts', items: toStringArray(relatedBundle.system_facts) }, { title: 'Related domain knowledge', items: toStringArray(relatedBundle.domain_knowledge) });
    }
    const intro = 'Use the following as prior context and preferences. If they conflict with current instructions, follow the current instructions.';
    const lines = [intro];
    let used = estimateTokens(intro);
    for (const section of sections) {
        const candidates = section.items.filter((item) => item.trim().length > 0);
        if (candidates.length === 0)
            continue;
        const header = `## ${section.title}`;
        const tentativeLines = [...lines, '', header];
        let tentativeUsed = used + estimateTokens(`\n\n${header}`);
        const includedItems = [];
        for (const item of candidates) {
            const line = `- ${truncate(item.replace(/\s+/g, ' ').trim(), MAX_PROMPT_MEMORY_ITEM_CHARS)}`;
            const cost = estimateTokens(`\n${line}`);
            if (tentativeUsed + cost > budget) {
                break;
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
function normalizeRole(role) {
    if (role === 'user' || role === 'assistant' || role === 'tool')
        return role;
    return null;
}
function shouldSendRole(role, config) {
    if (role === 'assistant')
        return config.send.roles.agent === 'enabled';
    return config.send.roles[role] === 'enabled';
}
/** Extract plain text from a pi-agent-core message content array */
function extractTextFromMessage(msg, allowedRoles = ['user', 'assistant']) {
    if (typeof msg !== 'object' || msg === null)
        return null;
    const m = msg;
    const role = normalizeRole(m['role']);
    if (!role || !allowedRoles.includes(role))
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
function resolveMessageTimestamp(msg) {
    if (typeof msg['timestamp'] === 'number')
        return new Date(msg['timestamp']).toISOString();
    if (typeof msg['timestamp'] === 'string')
        return msg['timestamp'];
    return null;
}
function hashString(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}
function buildMessageFingerprint(params) {
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
function pruneSessionKeyStores(stores, now) {
    for (const [sessionId, store] of stores) {
        if (now - store.lastSeen > MESSAGE_KEY_TTL_MS)
            stores.delete(sessionId);
    }
    while (stores.size > MAX_TRACKED_SESSIONS) {
        const oldest = [...stores.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if (!oldest)
            return;
        stores.delete(oldest[0]);
    }
}
function getSessionKeyStore(stores, sessionId, now) {
    pruneSessionKeyStores(stores, now);
    const existing = stores.get(sessionId);
    if (existing) {
        existing.lastSeen = now;
        return existing.keys;
    }
    const created = { keys: new Set(), lastSeen: now };
    stores.set(sessionId, created);
    return created.keys;
}
function rememberKeys(target, keys, limit = Number.POSITIVE_INFINITY) {
    for (const key of keys) {
        target.add(key);
        while (target.size > limit) {
            const oldest = target.values().next().value;
            if (!oldest)
                break;
            target.delete(oldest);
        }
    }
}
function forgetKeys(target, keys) {
    for (const key of keys)
        target.delete(key);
}
function summarizeOmissions(omissions) {
    if (omissions.length === 0)
        return 'none';
    const counts = new Map();
    for (const omission of omissions) {
        counts.set(omission.label, (counts.get(omission.label) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([label, count]) => `${label}:${count}`)
        .join(',');
}
function isTimeoutLikeError(err) {
    if (typeof err !== 'object' || err === null)
        return false;
    const record = err;
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    if (name === 'TimeoutError' || name === 'AbortError')
        return true;
    const message = typeof record['message'] === 'string' ? record['message'].toLowerCase() : '';
    return message.includes('timeout') || message.includes('aborted');
}
async function runGuardedRecall(args) {
    const now = Date.now();
    if (!args.breaker.canAttempt(now)) {
        args.logger?.warn?.(`openclaw-persistio: ${args.operation} skipped; recall circuit breaker open `
            + `for ${args.breaker.remainingMs(now)}ms`);
        return args.fallback;
    }
    try {
        const result = await withPluginDeadline(args.operation, args.timeoutMs + RECALL_GUARD_MARGIN_MS, args.run);
        args.breaker.recordSuccess();
        return result;
    }
    catch (err) {
        const opened = args.breaker.recordFailure();
        args.logger?.warn?.(`openclaw-persistio: ${args.operation} failed open: ${String(err)}`
            + (opened ? `; recall circuit breaker open for ${RECALL_CIRCUIT_BREAKER_COOLDOWN_MS}ms` : ''));
        return args.fallback;
    }
}
async function withPluginDeadline(operation, timeoutMs, run) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return run();
    }
    let timeout;
    const deadline = new Promise((_resolve, reject) => {
        timeout = setTimeout(() => {
            const err = new Error(`Persistio ${operation} exceeded plugin deadline after ${timeoutMs}ms`);
            err.name = 'TimeoutError';
            reject(err);
        }, timeoutMs);
    });
    try {
        return await Promise.race([run(), deadline]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
const PERSISTIO_MEMORY_PATH_PREFIX = 'persistio://memory/';
function jsonResult(payload) {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        details: payload,
    };
}
function buildMemorySearchUnavailableResult(error) {
    return {
        results: [],
        disabled: true,
        unavailable: true,
        error,
        warning: 'Persistio memory retrieval is currently unavailable.',
        action: 'Continue without memory for this turn.',
        debug: { backend: 'builtin', provider: 'persistio' },
    };
}
function resolveMemorySearchLimit(params) {
    const requested = resolveOptionalPositiveInteger(params.maxResults) ?? params.fallback;
    return clampPositiveInteger(requested, 1, MAX_MEMORY_SEARCH_RESULTS);
}
function createClient(config, recallTopK = config.recallTopK) {
    return new PersistioClient({ ...config, recallTopK });
}
function normalizeMemoryScore(memory) {
    if (typeof memory.similarity === 'number' && Number.isFinite(memory.similarity)) {
        return memory.similarity;
    }
    if (Number.isFinite(memory.confidence)) {
        return memory.confidence > 1 ? memory.confidence / 100 : memory.confidence;
    }
    return 0;
}
function buildMemoryPath(id) {
    return `${PERSISTIO_MEMORY_PATH_PREFIX}${id}`;
}
function parseMemoryPath(relPath) {
    return relPath.startsWith(PERSISTIO_MEMORY_PATH_PREFIX)
        ? relPath.slice(PERSISTIO_MEMORY_PATH_PREFIX.length)
        : null;
}
function formatMemoryDocument(memory) {
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
async function probePersistio(client) {
    try {
        await client.recall('__openclaw_probe__');
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
function createMemorySearchManager(config, recallBreaker, logger) {
    const client = createClient(config);
    return {
        async search(query, opts) {
            if (opts?.sources && !opts.sources.includes('memory')) {
                return [];
            }
            const recallTopK = resolveMemorySearchLimit({ maxResults: opts?.maxResults, fallback: config.recallTopK });
            const recallClient = createClient(config, recallTopK);
            const memories = await runGuardedRecall({
                operation: 'memory search recall',
                timeoutMs: config.recallTimeout,
                fallback: [],
                breaker: recallBreaker,
                logger,
                run: () => recallClient.recall(query),
            });
            return memories
                .map((memory) => {
                const score = normalizeMemoryScore(memory);
                return {
                    path: buildMemoryPath(memory.id),
                    startLine: 1,
                    endLine: 1,
                    score,
                    vectorScore: typeof memory.similarity === 'number' ? memory.similarity : undefined,
                    snippet: truncate(memory.data.replace(/\s+/g, ' ').trim(), MAX_MEMORY_SNIPPET_CHARS),
                    source: 'memory',
                    citation: memory.subject,
                };
            })
                .filter((result) => opts?.minScore === undefined || result.score >= opts.minScore);
        },
        async readFile(params) {
            const memoryId = parseMemoryPath(params.relPath);
            if (!memoryId) {
                throw new Error(`Unsupported Persistio memory path: ${params.relPath}`);
            }
            const memory = await client.getMemory(memoryId, { includePending: true });
            if (!memory) {
                throw new Error(`Persistio memory not found: ${memoryId}`);
            }
            const text = formatMemoryDocument(memory);
            const from = params.from ?? 1;
            const lines = text.split('\n');
            const startIndex = Math.max(0, from - 1);
            const requestedLines = params.lines && params.lines > 0 ? params.lines : 40;
            const sliced = lines.slice(startIndex, startIndex + requestedLines).join('\n');
            return {
                path: params.relPath,
                text: truncate(sliced, 2000),
                truncated: startIndex + requestedLines < lines.length || sliced.length > 2000,
                from,
                lines: requestedLines,
            };
        },
        status() {
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
function createMemoryRuntime(config, recallBreaker, logger) {
    return {
        async getMemorySearchManager() {
            return {
                manager: createMemorySearchManager(config, recallBreaker, logger),
            };
        },
        resolveMemoryBackendConfig() {
            return { backend: 'builtin' };
        },
    };
}
function buildPersistioMemoryPromptSection({ availableTools }) {
    const hasMemorySearch = availableTools.has('memory_search');
    const hasMemoryGet = availableTools.has('memory_get');
    if (!hasMemorySearch && !hasMemoryGet)
        return [];
    if (hasMemorySearch && hasMemoryGet) {
        return [
            '## Memory Recall',
            'Persistio is the active memory provider. For prior work, decisions, dates, people, preferences, or todos, use memory_search first and memory_get only for a bounded exact read of a returned persistio://memory/<id> path.',
            '',
        ];
    }
    return [
        '## Memory Recall',
        'Persistio is the active memory provider. Use the available memory tool for prior work, decisions, dates, people, preferences, or todos when memory context is needed.',
        '',
    ];
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
        const recallBreaker = new RecallCircuitBreaker();
        const sentMessageKeysBySession = new Map();
        const pendingMessageKeysBySession = new Map();
        api.registerMemoryCapability({
            promptBuilder: buildPersistioMemoryPromptSection,
            runtime: createMemoryRuntime(cfg, recallBreaker, api.logger),
        });
        // -------------------------------------------------------------------------
        // before_prompt_build — recall relevant memories and inject into context
        // Event: { prompt: string, messages: unknown[] }
        // Return: { appendSystemContext?: string }
        // -------------------------------------------------------------------------
        api.on('before_prompt_build', async (event) => {
            const query = buildRecallQuery(event);
            const block = await runGuardedRecall({
                operation: 'before_prompt_build recall',
                timeoutMs: cfg.recallTimeout,
                fallback: '',
                breaker: recallBreaker,
                logger: api.logger,
                run: async () => {
                    const recall = await client.recallBundle(query, undefined, { includeRelated: cfg.includeRelatedMemories });
                    return buildMemoryBlock(recall.bundle, cfg.tokenBudget, cfg.includeRelatedMemories ? recall.related_bundle : undefined);
                },
            });
            if (!block)
                return;
            return { appendSystemContext: block };
        }, { timeoutMs: cfg.recallTimeout + RECALL_GUARD_MARGIN_MS + 250 });
        // -------------------------------------------------------------------------
        // agent_end — ingest new turn messages (fire and forget)
        // Event: { runId?, messages: unknown[], success: boolean, error?, durationMs? }
        // Observation only — no return value.
        // -------------------------------------------------------------------------
        api.on('agent_end', async (event, context) => {
            try {
                const sessionId = context?.sessionId ?? event.runId ?? 'unknown-session';
                if (sessionId.startsWith('announce:'))
                    return;
                if (!shouldIngestSession(sessionId, cfg.ingest)) {
                    api.logger?.debug?.(`openclaw-persistio: ingest skipped non-main session: ${sessionId}`);
                    return;
                }
                const chunks = [];
                const chunkKeys = [];
                let agentCharsSent = 0;
                let originalChars = 0;
                let preparedChars = 0;
                let truncatedMessages = 0;
                let skippedMessages = 0;
                const omissions = [];
                const now = Date.now();
                const sentKeys = getSessionKeyStore(sentMessageKeysBySession, sessionId, now);
                const pendingKeys = getSessionKeyStore(pendingMessageKeysBySession, sessionId, now);
                for (const [index, msg] of event.messages.entries()) {
                    const m = msg;
                    const role = normalizeRole(m['role']);
                    if (!role || !shouldSendRole(role, cfg))
                        continue;
                    const text = extractTextFromMessage(msg, ['user', 'assistant', 'tool']);
                    if (!text || text.length === 0)
                        continue;
                    const key = buildMessageFingerprint({ sessionId, msg: m, role, text, index });
                    if (sentKeys.has(key) || pendingKeys.has(key))
                        continue;
                    const ts = resolveMessageTimestamp(m) ?? new Date().toISOString();
                    const prepared = prepareMessageForIngest({
                        role,
                        text,
                        policy: cfg.ingest,
                        remainingAgentChars: Math.max(0, cfg.ingest.agent.maxCharsPerTurn - agentCharsSent),
                        remainingChunks: Math.max(0, cfg.ingest.maxChunksPerTurn - chunks.length),
                    });
                    originalChars += prepared.originalChars;
                    preparedChars += prepared.preparedChars;
                    omissions.push(...prepared.omissions);
                    if (prepared.truncated)
                        truncatedMessages += 1;
                    if (prepared.chunks.length === 0) {
                        skippedMessages += 1;
                        continue;
                    }
                    chunkKeys.push(key);
                    if (role === 'assistant') {
                        agentCharsSent += prepared.preparedChars;
                    }
                    chunks.push(...prepared.chunks.map((content) => ({ role, content, timestamp: ts })));
                    if (chunks.length >= cfg.ingest.maxChunksPerTurn)
                        break;
                }
                if (chunks.length === 0)
                    return;
                if (truncatedMessages > 0 || omissions.length > 0 || skippedMessages > 0) {
                    api.logger?.info?.(`openclaw-persistio: ingest planned session=${sessionId} chunks=${chunks.length} `
                        + `originalChars=${originalChars} preparedChars=${preparedChars} `
                        + `truncatedMessages=${truncatedMessages} skippedMessages=${skippedMessages} `
                        + `omissions=${summarizeOmissions(omissions)}`);
                }
                rememberKeys(pendingKeys, chunkKeys);
                client.ingest(sessionId, chunks)
                    .then(() => {
                    rememberKeys(sentKeys, chunkKeys, MAX_SENT_KEYS_PER_SESSION);
                })
                    .catch((err) => {
                    if (isTimeoutLikeError(err)) {
                        rememberKeys(sentKeys, chunkKeys, MAX_SENT_KEYS_PER_SESSION);
                        api.logger?.warn?.(`openclaw-persistio: ingest timeout after ${cfg.ingest.timeoutMs}ms; `
                            + `outcome is ambiguous, suppressing retry for ${chunkKeys.length} messages in session=${sessionId}`);
                        return;
                    }
                    api.logger?.warn?.(`openclaw-persistio: ingest error: ${String(err)}`);
                })
                    .finally(() => {
                    forgetKeys(pendingKeys, chunkKeys);
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
        const memoryManager = createMemorySearchManager(cfg, recallBreaker, api.logger);
        api.registerTool({
            name: 'memory_search',
            label: 'Memory Search',
            description: 'Search Persistio semantic memory. Returns bounded structured results with persistio://memory/<id> paths for memory_get.',
            parameters: Type.Object({
                query: Type.String({ description: 'Search query' }),
                maxResults: Type.Optional(Type.Number({ description: 'Maximum results to return' })),
                minScore: Type.Optional(Type.Number({ description: 'Optional minimum score from 0 to 1' })),
                corpus: Type.Optional(Type.Union([
                    Type.Literal('memory'),
                    Type.Literal('wiki'),
                    Type.Literal('all'),
                    Type.Literal('sessions'),
                ], { description: 'Persistio supports memory corpus results' })),
            }, { additionalProperties: false }),
            async execute(_id, params) {
                const p = params;
                const query = typeof p.query === 'string' ? p.query.trim() : '';
                if (!query) {
                    return jsonResult(buildMemorySearchUnavailableResult('memory_search requires a non-empty query'));
                }
                const maxResults = resolveMemorySearchLimit({
                    maxResults: p.maxResults,
                    fallback: cfg.recallTopK,
                });
                const requestedCorpus = p.corpus ?? 'memory';
                const sources = requestedCorpus === 'sessions' || requestedCorpus === 'wiki'
                    ? []
                    : ['memory'];
                const startedAt = Date.now();
                try {
                    const results = sources.length === 0
                        ? []
                        : await memoryManager.search(query, {
                            maxResults,
                            minScore: p.minScore,
                            sources,
                        });
                    return jsonResult({
                        results: results.map((result) => ({ ...result, corpus: 'memory' })),
                        provider: 'persistio',
                        model: undefined,
                        fallback: false,
                        citations: 'off',
                        mode: 'persistio',
                        debug: {
                            backend: 'builtin',
                            effectiveMode: 'persistio',
                            requestedCorpus,
                            searchMs: Math.max(0, Date.now() - startedAt),
                            hits: results.length,
                        },
                    });
                }
                catch (err) {
                    return jsonResult(buildMemorySearchUnavailableResult(String(err)));
                }
            },
        });
        api.registerTool({
            name: 'memory_get',
            label: 'Memory Get',
            description: 'Read a bounded exact Persistio memory document by persistio://memory/<id> path.',
            parameters: Type.Object({
                path: Type.String({ description: 'Memory path returned by memory_search' }),
                from: Type.Optional(Type.Number({ description: 'Starting line, 1-based' })),
                lines: Type.Optional(Type.Number({ description: 'Maximum number of lines to return' })),
                corpus: Type.Optional(Type.Union([
                    Type.Literal('memory'),
                    Type.Literal('wiki'),
                    Type.Literal('all'),
                ])),
            }, { additionalProperties: false }),
            async execute(_id, params) {
                const p = params;
                const path = typeof p.path === 'string' ? p.path : '';
                if (p.corpus === 'wiki') {
                    return jsonResult({ path, text: '', disabled: true, error: 'Persistio does not provide a wiki corpus' });
                }
                try {
                    return jsonResult(await memoryManager.readFile({
                        relPath: path,
                        from: resolveOptionalPositiveInteger(p.from),
                        lines: resolveOptionalPositiveInteger(p.lines),
                    }));
                }
                catch (err) {
                    return jsonResult({ path, text: '', disabled: true, error: String(err) });
                }
            },
        });
        api.registerTool({
            name: 'persistio_memory_add',
            label: 'Add Persistio Memory',
            description: 'Manually store a fact in Persistio memory.',
            parameters: Type.Object({
                data: Type.String({ description: 'The fact to remember' }),
                subject: Type.String({ description: 'The entity or topic this fact is about' }),
            }),
            async execute(_id, params) {
                const p = params;
                try {
                    await client.addMemory(p.data, p.subject);
                }
                catch (err) {
                    if (isTimeoutLikeError(err)) {
                        api.logger?.warn?.(`openclaw-persistio: persistio_memory_add timeout after ${cfg.ingest.timeoutMs}ms; outcome is ambiguous`);
                        return {
                            content: [{
                                    type: 'text',
                                    text: 'Memory store request timed out; it may still complete. Check persistio_memory_list before retrying.',
                                }],
                            details: { ambiguous: true },
                        };
                    }
                    throw err;
                }
                return { content: [{ type: 'text', text: 'Memory stored.' }], details: null };
            },
        }, { optional: true });
        api.registerTool({
            name: 'persistio_memory_delete',
            label: 'Delete Persistio Memory',
            description: 'Delete a specific Persistio memory by its ID.',
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
            name: 'persistio_memory_list',
            label: 'List Persistio Memories',
            description: 'List stored Persistio memories.',
            parameters: Type.Object({}),
            async execute(_id, _params) {
                const memories = await client.listMemories();
                const text = memories.length > 0
                    ? memories.map(m => `[${m.id}] ${truncate(m.data.replace(/\s+/g, ' ').trim(), MAX_MEMORY_SNIPPET_CHARS)} (${m.subject})`).join('\n')
                    : 'No memories stored.';
                return { content: [{ type: 'text', text }], details: null };
            },
        }, { optional: true });
    },
});
