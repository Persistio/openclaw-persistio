import type { RecallBundle } from './client.js';
export declare function normalizeRecallQuery(text: string, maxChars: number): string;
export declare function extractTextFromMessage(message: unknown): string;
export declare function buildRecallQuery(event: {
    prompt?: string;
    messages?: unknown[];
}, maxChars: number): string;
export declare function buildMemoryBlock(bundle: RecallBundle | undefined, tokenBudget: number, relatedBundle?: RecallBundle): string;
