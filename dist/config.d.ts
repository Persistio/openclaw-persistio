export type PersistioCaptureRoleStatus = 'enabled' | 'bounded' | 'disabled';
export interface PersistioV2Config {
    baseURL: string;
    apiKey: string;
    autoRecall: boolean;
    autoCapture: boolean;
    recall: {
        timeoutMs: number;
        maxResults: number;
        tokenBudget: number;
        minSimilarity?: number;
        includePending: boolean;
        includeRelated: boolean;
        queryMaxChars: number;
    };
    capture: {
        timeoutMs: number;
        maxCharsPerTurn: number;
        maxCharsPerMessage: number;
        maxChunksPerTurn: number;
        maxChunkChars: number;
        roles: {
            user: 'enabled' | 'disabled';
            assistant: PersistioCaptureRoleStatus;
            tool: 'enabled' | 'disabled';
        };
    };
}
export declare function resolveConfig(raw: unknown): PersistioV2Config;
