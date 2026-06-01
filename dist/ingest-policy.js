export const DEFAULT_INGEST_POLICY = {
    timeoutMs: 30000,
    maxChunkChars: 6000,
    maxChunksPerTurn: 12,
    skipSubagentSessions: true,
    user: {
        maxCharsPerMessage: 24000,
    },
    agent: {
        mode: 'bounded',
        maxCharsPerMessage: 24000,
        maxCharsAfterFiltering: 9000,
        maxCharsPerTurn: 24000,
        largeBlockThresholdChars: 1200,
        largeBlockThresholdLines: 80,
        maxTableRows: 12,
    },
};
function readNumber(value, fallback, min = 1) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min
        ? Math.floor(value)
        : fallback;
}
function readBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function readObject(value) {
    return typeof value === 'object' && value !== null
        ? value
        : {};
}
export function resolveIngestPolicy(raw) {
    const ingest = readObject(raw);
    const user = readObject(ingest['user']);
    const agent = readObject(ingest['agent']);
    const mode = agent['mode'] === 'raw' ? 'raw' : DEFAULT_INGEST_POLICY.agent.mode;
    return {
        timeoutMs: readNumber(ingest['timeoutMs'], DEFAULT_INGEST_POLICY.timeoutMs),
        maxChunkChars: readNumber(ingest['maxChunkChars'], DEFAULT_INGEST_POLICY.maxChunkChars, 256),
        maxChunksPerTurn: readNumber(ingest['maxChunksPerTurn'], DEFAULT_INGEST_POLICY.maxChunksPerTurn),
        skipSubagentSessions: readBoolean(ingest['skipSubagentSessions'], DEFAULT_INGEST_POLICY.skipSubagentSessions),
        user: {
            maxCharsPerMessage: readNumber(user['maxCharsPerMessage'], DEFAULT_INGEST_POLICY.user.maxCharsPerMessage),
        },
        agent: {
            mode,
            maxCharsPerMessage: readNumber(agent['maxCharsPerMessage'], DEFAULT_INGEST_POLICY.agent.maxCharsPerMessage),
            maxCharsAfterFiltering: readNumber(agent['maxCharsAfterFiltering'], DEFAULT_INGEST_POLICY.agent.maxCharsAfterFiltering),
            maxCharsPerTurn: readNumber(agent['maxCharsPerTurn'], DEFAULT_INGEST_POLICY.agent.maxCharsPerTurn),
            largeBlockThresholdChars: readNumber(agent['largeBlockThresholdChars'], DEFAULT_INGEST_POLICY.agent.largeBlockThresholdChars),
            largeBlockThresholdLines: readNumber(agent['largeBlockThresholdLines'], DEFAULT_INGEST_POLICY.agent.largeBlockThresholdLines),
            maxTableRows: readNumber(agent['maxTableRows'], DEFAULT_INGEST_POLICY.agent.maxTableRows),
        },
    };
}
export function shouldIngestSession(sessionId, policy) {
    if (!policy.skipSubagentSessions)
        return true;
    return !sessionId.startsWith('agent:') || sessionId.startsWith('agent:main:');
}
function countLines(text) {
    return text.length === 0 ? 0 : text.split('\n').length;
}
function marker(label, text, extra) {
    const suffix = extra ? `, ${extra}` : '';
    return `[${label} omitted: ${countLines(text)} lines, ${text.length} chars${suffix}]`;
}
function normalizeText(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}
function pushOmission(omissions, label, text) {
    omissions.push({ label, chars: text.length, lines: countLines(text) });
}
function collapseLargeFencedBlocks(text, policy, omissions) {
    return text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (block, language) => {
        if (block.length < policy.agent.largeBlockThresholdChars &&
            countLines(block) < policy.agent.largeBlockThresholdLines) {
            return block;
        }
        pushOmission(omissions, 'Code block', block);
        const lang = language.trim();
        return marker('Code block', block, lang ? `language=${lang}` : undefined);
    });
}
function isBase64LikeLine(line) {
    const compact = line.trim();
    if (compact.length < 500 || /\s/.test(compact))
        return false;
    if (!/^[A-Za-z0-9+/=_-]+$/.test(compact))
        return false;
    const alphaNumeric = compact.replace(/[^A-Za-z0-9]/g, '').length / compact.length;
    return alphaNumeric > 0.85;
}
function collapseBase64Lines(text, omissions) {
    return text.split('\n').map((line) => {
        if (!isBase64LikeLine(line))
            return line;
        pushOmission(omissions, 'Encoded blob', line);
        return `[Encoded blob omitted: 1 line, ${line.length} chars]`;
    }).join('\n');
}
function looksLikeDiffStart(line) {
    return /^diff --git\b/.test(line) || line === '*** Begin Patch';
}
function isDiffMetadataLine(line) {
    return /^(?:index|new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to)\b/.test(line)
        || /^(?:---|\+\+\+) /.test(line)
        || /^Binary files .+ differ$/.test(line)
        || /^\*\*\* (?:Add|Update|Delete) File: /.test(line)
        || /^\*\*\* End of File$/.test(line);
}
function isDiffBodyLine(line) {
    return /^@@/.test(line)
        || /^[ +\\-]/.test(line);
}
function collapseDiffBlocks(text, policy, omissions) {
    const lines = text.split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!looksLikeDiffStart(line)) {
            result.push(line);
            continue;
        }
        const block = [line];
        i += 1;
        for (; i < lines.length; i += 1) {
            const next = lines[i];
            if (looksLikeDiffStart(next)) {
                i -= 1;
                break;
            }
            if (next === '*** End Patch') {
                block.push(next);
                break;
            }
            if (next.trim() === '') {
                i -= 1;
                break;
            }
            if (!isDiffMetadataLine(next) && !isDiffBodyLine(next)) {
                i -= 1;
                break;
            }
            block.push(next);
        }
        const blockText = block.join('\n');
        if (blockText.length < policy.agent.largeBlockThresholdChars &&
            block.length < policy.agent.largeBlockThresholdLines) {
            result.push(blockText);
            continue;
        }
        pushOmission(omissions, 'Diff', blockText);
        result.push(marker('Diff', blockText));
    }
    return result.join('\n');
}
function isLogLikeLine(line) {
    return /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/.test(line)
        || /^\s*(ERROR|WARN|INFO|DEBUG|TRACE)\b/.test(line)
        || /^\s*at\s+.+\(.+:\d+:\d+\)/.test(line)
        || /^\s*at\s+.+:\d+:\d+/.test(line)
        || /^Traceback \(most recent call last\):/.test(line)
        || /^[A-Za-z]*Error: .+/.test(line);
}
function isShellOutputLine(line) {
    return /^\s*(PASS|FAIL|RUNS|Test Files|Tests|Duration|stderr|stdout)\b/.test(line)
        || /^>\s+[\w@/.-]+/.test(line)
        || /^\$\s+\S+/.test(line)
        || /^npm (ERR!|WARN|notice)\b/.test(line);
}
function collapseLineRuns(text, label, predicate, policy, omissions) {
    const lines = text.split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!predicate(line)) {
            result.push(line);
            continue;
        }
        const block = [line];
        i += 1;
        for (; i < lines.length; i += 1) {
            const next = lines[i];
            if (!predicate(next)) {
                i -= 1;
                break;
            }
            block.push(next);
        }
        const blockText = block.join('\n');
        if (blockText.length < policy.agent.largeBlockThresholdChars &&
            block.length < policy.agent.largeBlockThresholdLines) {
            result.push(blockText);
            continue;
        }
        pushOmission(omissions, label, blockText);
        const firstUsefulLine = block.find((candidate) => candidate.trim().length > 0)?.trim();
        result.push(marker(label, blockText, firstUsefulLine ? `first="${firstUsefulLine.slice(0, 120)}"` : undefined));
    }
    return result.join('\n');
}
function isMarkdownTableLine(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.split('|').length >= 4;
}
function isMarkdownTableSeparator(line) {
    return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}
function truncateMarkdownTables(text, policy, omissions) {
    const lines = text.split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (!isMarkdownTableLine(lines[i]) || !lines[i + 1] || !isMarkdownTableSeparator(lines[i + 1])) {
            result.push(lines[i]);
            continue;
        }
        const table = [lines[i], lines[i + 1]];
        i += 2;
        for (; i < lines.length && isMarkdownTableLine(lines[i]); i += 1) {
            table.push(lines[i]);
        }
        i -= 1;
        if (table.length <= policy.agent.maxTableRows + 2) {
            result.push(...table);
            continue;
        }
        const omitted = table.slice(policy.agent.maxTableRows + 2).join('\n');
        pushOmission(omissions, 'Table rows', omitted);
        result.push(...table.slice(0, policy.agent.maxTableRows + 2));
        result.push(`[Table truncated: ${table.length - policy.agent.maxTableRows - 2} more rows]`);
    }
    return result.join('\n');
}
function maybeCollapseWholeBlob(text, omissions) {
    const trimmed = text.trim();
    if (trimmed.length < 2000)
        return text;
    try {
        const parsed = JSON.parse(trimmed);
        pushOmission(omissions, 'JSON blob', text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const keys = Object.keys(parsed).slice(0, 12).join(',');
            return `[JSON blob omitted: ${countLines(text)} lines, ${text.length} chars${keys ? `, keys=${keys}` : ''}]`;
        }
        return marker('JSON blob', text);
    }
    catch {
        // Continue with XML-ish shape detection below.
    }
    const angleRatio = (trimmed.match(/[<>/]/g)?.length ?? 0) / trimmed.length;
    const lineCount = countLines(trimmed);
    if (lineCount >= 20 &&
        angleRatio > 0.08 &&
        /^<\??[A-Za-z!]/.test(trimmed) &&
        /<\/[A-Za-z][^>]*>/.test(trimmed)) {
        pushOmission(omissions, 'XML blob', text);
        return marker('XML blob', text);
    }
    return text;
}
function fitToBudget(text, budget) {
    if (text.length <= budget) {
        return { text, truncated: false };
    }
    const markerText = `\n\n[Content truncated: original ${text.length} chars, kept ${budget} chars]\n\n`;
    const available = Math.max(0, budget - markerText.length);
    const headLength = Math.ceil(available * 0.6);
    const tailLength = Math.max(0, available - headLength);
    return {
        text: `${text.slice(0, headLength).trimEnd()}${markerText}${text.slice(text.length - tailLength).trimStart()}`.trim(),
        truncated: true,
    };
}
export function filterAssistantContent(text, policy) {
    const omissions = [];
    let filtered = normalizeText(text);
    if (policy.agent.mode === 'bounded') {
        filtered = collapseLargeFencedBlocks(filtered, policy, omissions);
        filtered = collapseDiffBlocks(filtered, policy, omissions);
        filtered = collapseLineRuns(filtered, 'Log output', isLogLikeLine, policy, omissions);
        filtered = collapseLineRuns(filtered, 'Command output', isShellOutputLine, policy, omissions);
        filtered = truncateMarkdownTables(filtered, policy, omissions);
        filtered = collapseBase64Lines(filtered, omissions);
        filtered = maybeCollapseWholeBlob(filtered, omissions);
    }
    const budgeted = fitToBudget(filtered, policy.agent.maxCharsAfterFiltering);
    return {
        text: budgeted.text,
        omissions,
        truncated: budgeted.truncated,
    };
}
export function chunkText(text, maxChunkChars) {
    const normalized = normalizeText(text);
    if (!normalized)
        return [];
    const chunks = [];
    let current = '';
    const flush = () => {
        if (!current.trim())
            return;
        chunks.push(current.trim());
        current = '';
    };
    const appendUnit = (unit) => {
        const separator = current ? '\n\n' : '';
        if (current.length + separator.length + unit.length <= maxChunkChars) {
            current = `${current}${separator}${unit}`;
            return;
        }
        flush();
        if (unit.length <= maxChunkChars) {
            current = unit;
            return;
        }
        for (let start = 0; start < unit.length; start += maxChunkChars) {
            chunks.push(unit.slice(start, start + maxChunkChars).trim());
        }
    };
    for (const paragraph of normalized.split(/\n{2,}/)) {
        if (paragraph.length <= maxChunkChars) {
            appendUnit(paragraph);
            continue;
        }
        for (const line of paragraph.split('\n')) {
            appendUnit(line);
        }
    }
    flush();
    return chunks.filter((chunk) => chunk.length > 0);
}
export function prepareMessageForIngest(input) {
    const original = normalizeText(input.text);
    const omissions = [];
    let prepared = original;
    let truncated = false;
    if (input.role === 'assistant') {
        const messageBudget = input.remainingAgentChars;
        if (messageBudget <= 0 || input.remainingChunks <= 0) {
            return {
                chunks: [],
                originalChars: original.length,
                preparedChars: 0,
                truncated: true,
                omissions: [],
            };
        }
        const preBudgeted = fitToBudget(prepared, input.policy.agent.maxCharsPerMessage);
        prepared = preBudgeted.text;
        truncated = preBudgeted.truncated;
        const filtered = filterAssistantContent(prepared, input.policy);
        prepared = filtered.text;
        omissions.push(...filtered.omissions);
        truncated = truncated || filtered.truncated || filtered.omissions.length > 0;
        const budgeted = fitToBudget(prepared, messageBudget);
        prepared = budgeted.text;
        truncated = truncated || budgeted.truncated;
    }
    else if (input.role === 'user') {
        const budgeted = fitToBudget(prepared, input.policy.user.maxCharsPerMessage);
        prepared = budgeted.text;
        truncated = budgeted.truncated;
    }
    const chunks = chunkText(prepared, input.policy.maxChunkChars).slice(0, input.remainingChunks);
    if (chunks.join('\n\n').length < prepared.length) {
        truncated = true;
    }
    return {
        chunks,
        originalChars: original.length,
        preparedChars: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        truncated,
        omissions,
    };
}
