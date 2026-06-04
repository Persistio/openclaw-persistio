import type { PersistioIngestPolicy } from './ingest-policy.js';
export interface PersistioConfig {
    baseURL: string;
    apiKey: string;
    tokenBudget: number;
    recallTopK: number;
    recallMinSimilarity?: number;
    recallTimeout: number;
    recallIncludePending: boolean;
    includeRelatedMemories: boolean;
    ingest: PersistioIngestPolicy;
    send: PersistioSendConfig;
}
export type PersistioSendRoleStatus = 'enabled' | 'disabled';
export interface PersistioSendConfig {
    roles: {
        user: PersistioSendRoleStatus;
        agent: PersistioSendRoleStatus;
        tool: PersistioSendRoleStatus;
    };
}
export interface PersistioMemory {
    id: string;
    data: string;
    subject: string;
    similarity?: number;
    categories: string[];
    confidence: number;
}
export interface GetMemoryOptions {
    includePending?: boolean;
}
export interface RecallBundle {
    global_user_rules?: string[];
    user_rules: string[];
    user_preferences: string[];
    task_patterns: string[];
    workflows: string[];
    project: string[];
    constraints: string[];
    decisions: string[];
    system_facts: string[];
    domain_knowledge: string[];
}
export interface RecallBundleResponse {
    bundle: RecallBundle;
    related_bundle?: RecallBundle;
}
export interface RecallBundleOptions {
    includeRelated?: boolean;
}
export declare class PersistioTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number);
}
export declare class PersistioClient {
    private readonly baseURL;
    private readonly apiKey;
    private readonly recallTopK;
    private readonly recallMinSimilarity?;
    private readonly recallTimeout;
    private readonly recallIncludePending;
    private readonly includeRelatedMemories;
    private readonly ingestTimeout;
    private readonly writeTimeout;
    constructor(config: PersistioConfig);
    private headers;
    recall(query: string): Promise<PersistioMemory[]>;
    recallBundle(query: string, topK?: number, options?: RecallBundleOptions): Promise<RecallBundleResponse>;
    ingest(sessionId: string, chunks: Array<{
        role: string;
        content: string;
        timestamp: string;
    }>): Promise<void>;
    addMemory(data: string, subject: string): Promise<void>;
    deleteMemory(id: string): Promise<void>;
    getMemory(id: string, options?: GetMemoryOptions): Promise<PersistioMemory | null>;
    listMemories(): Promise<PersistioMemory[]>;
}
