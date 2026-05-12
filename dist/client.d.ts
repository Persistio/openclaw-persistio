export interface PersistioConfig {
    baseURL: string;
    apiKey: string;
    tokenBudget: number;
    recallTopK: number;
    recallTimeout: number;
}
export interface PersistioMemory {
    id: string;
    data: string;
    subject: string;
    similarity?: number;
    categories: string[];
    confidence: number;
}
export interface RecallBundle {
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
}
export declare class PersistioClient {
    private readonly baseURL;
    private readonly apiKey;
    private readonly recallTopK;
    private readonly recallTimeout;
    constructor(config: PersistioConfig);
    private headers;
    recall(query: string, topK?: number): Promise<PersistioMemory[]>;
    recallBundle(query: string, topK?: number): Promise<RecallBundle>;
    ingest(sessionId: string, chunks: Array<{
        role: string;
        content: string;
        timestamp: string;
    }>): Promise<void>;
    addMemory(data: string, subject: string): Promise<void>;
    deleteMemory(id: string): Promise<void>;
    listMemories(): Promise<PersistioMemory[]>;
}
