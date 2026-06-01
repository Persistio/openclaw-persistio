export type OpenClawMessageRole = 'user' | 'assistant' | 'tool';
export interface PersistioIngestPolicy {
    timeoutMs: number;
    maxChunkChars: number;
    maxChunksPerTurn: number;
    skipSubagentSessions: boolean;
    user: {
        maxCharsPerMessage: number;
    };
    agent: {
        mode: 'bounded' | 'raw';
        maxCharsPerMessage: number;
        maxCharsAfterFiltering: number;
        maxCharsPerTurn: number;
        largeBlockThresholdChars: number;
        largeBlockThresholdLines: number;
        maxTableRows: number;
    };
}
export interface OmissionSummary {
    label: string;
    chars: number;
    lines: number;
}
export interface PreparedIngestMessage {
    chunks: string[];
    originalChars: number;
    preparedChars: number;
    truncated: boolean;
    omissions: OmissionSummary[];
}
export interface PrepareMessageInput {
    role: OpenClawMessageRole;
    text: string;
    policy: PersistioIngestPolicy;
    remainingAgentChars: number;
    remainingChunks: number;
}
export declare const DEFAULT_INGEST_POLICY: PersistioIngestPolicy;
export declare function resolveIngestPolicy(raw: unknown): PersistioIngestPolicy;
export declare function shouldIngestSession(sessionId: string, policy: PersistioIngestPolicy): boolean;
export declare function filterAssistantContent(text: string, policy: PersistioIngestPolicy): {
    text: string;
    omissions: OmissionSummary[];
    truncated: boolean;
};
export declare function chunkText(text: string, maxChunkChars: number): string[];
export declare function prepareMessageForIngest(input: PrepareMessageInput): PreparedIngestMessage;
