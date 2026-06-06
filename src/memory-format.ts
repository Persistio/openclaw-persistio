import type { RecallBundle } from './client.js';

const BUNDLE_SECTIONS: Array<{ key: keyof RecallBundle; title: string }> = [
  { key: 'global_user_rules', title: 'User Rules' },
  { key: 'user_rules', title: 'User Rules' },
  { key: 'user_preferences', title: 'User Preferences' },
  { key: 'constraints', title: 'Constraints' },
  { key: 'decisions', title: 'Decisions' },
  { key: 'task_patterns', title: 'Task Patterns' },
  { key: 'workflows', title: 'Workflows' },
  { key: 'project', title: 'Project Memory' },
  { key: 'system_facts', title: 'Facts' },
  { key: 'domain_knowledge', title: 'Domain Knowledge' },
];

export function normalizeRecallQuery(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function extractTextFromMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (typeof message !== 'object' || message === null) return '';

  const record = message as Record<string, unknown>;
  const content = record['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null) return '';
      const partRecord = part as Record<string, unknown>;
      return partRecord['type'] === 'text' && typeof partRecord['text'] === 'string'
        ? partRecord['text']
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function buildRecallQuery(event: { prompt?: string; messages?: unknown[] }, maxChars: number): string {
  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  if (prompt.trim()) return normalizeRecallQuery(prompt, maxChars);

  const latestUser = Array.isArray(event.messages)
    ? findLatestRoleText(event.messages, 'user')
    : '';
  return normalizeRecallQuery(latestUser, maxChars);
}

export function buildMemoryBlock(
  bundle: RecallBundle | undefined,
  tokenBudget: number,
  relatedBundle?: RecallBundle,
): string {
  if ((!bundle && !relatedBundle) || tokenBudget <= 0) return '';

  const lines: string[] = [
    '## Persistio Memory',
    'Relevant durable memory:',
  ];
  let usedTokens = estimateTokens(lines.join('\n'));

  for (const section of BUNDLE_SECTIONS) {
    const items = uniqueStrings([
      ...arrayStrings(bundle?.[section.key]),
      ...arrayStrings(relatedBundle?.[section.key]),
    ]);
    for (const item of items) {
      const line = `- ${truncateOneLine(item, 360)}`;
      const lineTokens = estimateTokens(line);
      if (usedTokens + lineTokens > tokenBudget) {
        lines.push('', 'Use these only when relevant. Do not mention memory unless asked.');
        return lines.join('\n');
      }
      lines.push(line);
      usedTokens += lineTokens;
    }
  }

  if (lines.length <= 2) return '';
  lines.push('', 'Use these only when relevant. Do not mention memory unless asked.');
  return lines.join('\n');
}

function findLatestRoleText(messages: unknown[], role: string): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== 'object' || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record['role'] !== role) continue;
    const text = extractTextFromMessage(message).trim();
    if (text) return text;
  }
  return '';
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function uniqueStrings(value: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const normalized = item.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function truncateOneLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
