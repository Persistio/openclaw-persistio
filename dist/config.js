const DEFAULT_CONFIG = {
    baseURL: '',
    apiKey: '',
    autoRecall: true,
    autoCapture: true,
    recall: {
        timeoutMs: 1200,
        maxResults: 4,
        tokenBudget: 400,
        includePending: false,
        includeRelated: false,
        queryMaxChars: 1200,
    },
    capture: {
        timeoutMs: 10000,
        maxCharsPerTurn: 6000,
        maxCharsPerMessage: 3000,
        maxChunksPerTurn: 4,
        maxChunkChars: 2000,
        roles: {
            user: 'enabled',
            assistant: 'bounded',
            tool: 'disabled',
        },
    },
};
function readObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function readString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function readPositiveInteger(value, fallback, min = 1) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min
        ? Math.floor(value)
        : fallback;
}
function readSimilarity(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : undefined;
}
function readEnabledDisabled(value, fallback) {
    return value === 'enabled' || value === 'disabled' ? value : fallback;
}
function readAssistantRole(value, fallback) {
    return value === 'enabled' || value === 'bounded' || value === 'disabled' ? value : fallback;
}
export function resolveConfig(raw) {
    const input = readObject(raw);
    const recall = readObject(input['recall']);
    const capture = readObject(input['capture']);
    const roles = readObject(capture['roles']);
    return {
        baseURL: readString(input['baseURL'], DEFAULT_CONFIG.baseURL),
        apiKey: readString(input['apiKey'], DEFAULT_CONFIG.apiKey),
        autoRecall: readBoolean(input['autoRecall'], DEFAULT_CONFIG.autoRecall),
        autoCapture: readBoolean(input['autoCapture'], DEFAULT_CONFIG.autoCapture),
        recall: {
            timeoutMs: readPositiveInteger(recall['timeoutMs'], DEFAULT_CONFIG.recall.timeoutMs),
            maxResults: readPositiveInteger(recall['maxResults'], DEFAULT_CONFIG.recall.maxResults),
            tokenBudget: readPositiveInteger(recall['tokenBudget'], DEFAULT_CONFIG.recall.tokenBudget),
            minSimilarity: readSimilarity(recall['minSimilarity']),
            includePending: readBoolean(recall['includePending'], DEFAULT_CONFIG.recall.includePending),
            includeRelated: readBoolean(recall['includeRelated'], DEFAULT_CONFIG.recall.includeRelated),
            queryMaxChars: readPositiveInteger(recall['queryMaxChars'], DEFAULT_CONFIG.recall.queryMaxChars, 100),
        },
        capture: {
            timeoutMs: readPositiveInteger(capture['timeoutMs'], DEFAULT_CONFIG.capture.timeoutMs),
            maxCharsPerTurn: readPositiveInteger(capture['maxCharsPerTurn'], DEFAULT_CONFIG.capture.maxCharsPerTurn),
            maxCharsPerMessage: readPositiveInteger(capture['maxCharsPerMessage'], DEFAULT_CONFIG.capture.maxCharsPerMessage),
            maxChunksPerTurn: readPositiveInteger(capture['maxChunksPerTurn'], DEFAULT_CONFIG.capture.maxChunksPerTurn),
            maxChunkChars: readPositiveInteger(capture['maxChunkChars'], DEFAULT_CONFIG.capture.maxChunkChars, 256),
            roles: {
                user: readEnabledDisabled(roles['user'], DEFAULT_CONFIG.capture.roles.user),
                assistant: readAssistantRole(roles['assistant'], DEFAULT_CONFIG.capture.roles.assistant),
                tool: readEnabledDisabled(roles['tool'], DEFAULT_CONFIG.capture.roles.tool),
            },
        },
    };
}
