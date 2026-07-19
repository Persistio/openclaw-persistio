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
    provenance?: CaptureProvenance;
}
export interface CaptureProvenance {
    source_class?: 'agent_cron' | 'agent_hook' | 'agent_slack' | 'agent_subagent' | 'agent_other' | 'thread_conversation' | 'direct_or_import' | 'unknown';
    actor_type: 'human' | 'assistant' | 'agent' | 'tool' | 'system' | 'import' | 'unknown';
    trigger_type: 'direct' | 'delegated' | 'scheduled' | 'event' | 'backfill' | 'api' | 'unknown';
    artifact_type: 'message' | 'conversation' | 'tool_result' | 'status' | 'observation' | 'log' | 'summary' | 'document' | 'unknown';
    authorship: 'original' | 'generated' | 'transcribed' | 'imported' | 'mixed' | 'unknown';
    cadence: 'one_off' | 'recurring' | 'batch' | 'unknown';
    provenance_confidence?: number;
    provenance_basis?: Array<'session_id_prefix' | 'agent_trigger' | 'integration_marker' | 'thread_session_shape' | 'session_id_shape' | 'role_counts' | 'plugin_capture' | 'api_provenance' | 'api_provenance_aggregate' | 'fallback'>;
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
