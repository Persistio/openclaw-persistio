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
export declare class PersistioClient {
    private readonly baseURL;
    private readonly apiKey;
    private readonly recallTopK;
    private readonly recallTimeout;
    constructor(config: PersistioConfig);
    private headers;
    recall(query: string): Promise<PersistioMemory[]>;
    ingest(sessionId: string, chunks: Array<{
        role: string;
        content: string;
    }>): Promise<void>;
    addMemory(data: string, subject: string): Promise<void>;
    deleteMemory(id: string): Promise<void>;
    listMemories(): Promise<PersistioMemory[]>;
}
