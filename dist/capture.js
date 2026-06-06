import { extractTextFromMessage } from './memory-format.js';
export function prepareCapture(event, cfg, options = {}) {
    if (!Array.isArray(event.messages))
        return { chunks: [], keys: [], items: [] };
    const chunks = [];
    const keys = [];
    const items = [];
    let turnChars = 0;
    for (const [index, message] of event.messages.entries()) {
        const role = normalizeRole(message);
        if (!role || !shouldCaptureRole(role, cfg))
            continue;
        const rawText = extractTextFromMessage(message);
        const key = messageKey(message, role, rawText, index);
        if (options.shouldIncludeKey && !options.shouldIncludeKey(key))
            continue;
        if (chunks.length >= cfg.capture.maxChunksPerTurn)
            break;
        const preparedText = prepareTextForRole(rawText, role, cfg);
        if (!preparedText)
            continue;
        const remainingTurnChars = cfg.capture.maxCharsPerTurn - turnChars;
        if (remainingTurnChars <= 0)
            break;
        const boundedText = truncate(preparedText, Math.min(cfg.capture.maxCharsPerMessage, remainingTurnChars));
        const itemChunks = [];
        for (const chunk of chunkText(boundedText, cfg.capture.maxChunkChars)) {
            if (chunks.length >= cfg.capture.maxChunksPerTurn)
                break;
            const ingestChunk = {
                role,
                content: chunk,
                timestamp: resolveTimestamp(message) ?? new Date().toISOString(),
            };
            chunks.push(ingestChunk);
            itemChunks.push(ingestChunk);
            turnChars += chunk.length;
        }
        if (itemChunks.length > 0) {
            keys.push(key);
            items.push({ key, chunks: itemChunks });
        }
    }
    return { chunks, keys, items };
}
function normalizeRole(message) {
    if (typeof message !== 'object' || message === null)
        return null;
    const role = message['role'];
    return role === 'user' || role === 'assistant' || role === 'tool' ? role : null;
}
function shouldCaptureRole(role, cfg) {
    if (role === 'user')
        return cfg.capture.roles.user === 'enabled';
    if (role === 'assistant')
        return cfg.capture.roles.assistant !== 'disabled';
    return cfg.capture.roles.tool === 'enabled';
}
function prepareTextForRole(text, role, cfg) {
    const normalized = normalizeText(text);
    if (!normalized)
        return '';
    if (role !== 'assistant' || cfg.capture.roles.assistant !== 'bounded') {
        return normalized;
    }
    return normalized
        .replace(/```[\s\S]*?```/g, '[Code block omitted from memory capture]')
        .replace(/\n(?:[|].*[|]\n){8,}/g, '\n[Large table omitted from memory capture]\n')
        .replace(/\n(?:[-+].*\n){20,}/g, '\n[Large diff/log omitted from memory capture]\n')
        .trim();
}
function normalizeText(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}
function chunkText(text, maxChars) {
    if (text.length <= maxChars)
        return [text];
    const chunks = [];
    for (let start = 0; start < text.length; start += maxChars) {
        const chunk = text.slice(start, start + maxChars).trim();
        if (chunk)
            chunks.push(chunk);
    }
    return chunks;
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function resolveTimestamp(message) {
    if (typeof message !== 'object' || message === null)
        return undefined;
    const value = message['timestamp'];
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return new Date(value).toISOString();
    return undefined;
}
function messageKey(message, role, text, index) {
    if (typeof message === 'object' && message !== null) {
        const id = message['id'];
        if (typeof id === 'string' && id)
            return `${role}:${id}`;
    }
    return `${role}:${index}:${text.slice(0, 300)}`;
}
