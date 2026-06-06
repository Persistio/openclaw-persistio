import type { PersistioV2Config } from './config.js';
export interface PersistioMemory {
    id: string;
    data: string;
    subject: string;
    similarity?: number;
    confidence?: number;
    categories?: string[];
    source?: string;
    edge_type?: string | null;
}
export interface RecallBundle {
    global_user_rules?: string[];
    user_rules?: string[];
    user_preferences?: string[];
    task_patterns?: string[];
    workflows?: string[];
    project?: string[];
    constraints?: string[];
    decisions?: string[];
    system_facts?: string[];
    domain_knowledge?: string[];
}
export interface RecallBundleResponse {
    bundle?: RecallBundle;
    related_bundle?: RecallBundle;
}
export interface RecallResult {
    memories: PersistioMemory[];
    relatedMemories: PersistioMemory[];
}
export interface IngestChunk {
    role: string;
    content: string;
    timestamp: string;
}
export declare class PersistioTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number);
}
export declare class PersistioClient {
    private readonly config;
    private readonly baseURL;
    private readonly apiKey;
    constructor(config: PersistioV2Config);
    recall(query: string, options?: {
        maxResults?: number;
    }): Promise<RecallResult>;
    recallBundle(query: string): Promise<RecallBundleResponse>;
    ingest(sessionId: string, chunks: IngestChunk[]): Promise<void>;
    storeMemory(data: string, subject: string): Promise<PersistioMemory>;
    forgetMemory(id: string): Promise<void>;
    private buildRecallBody;
    private headers;
}
export declare function withRequestDeadline<T>(operation: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
