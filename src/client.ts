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

export class PersistioTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Persistio ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export class PersistioClient {
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor(private readonly config: PersistioV2Config) {
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  async recall(query: string, options: { maxResults?: number } = {}): Promise<RecallResult> {
    return withRequestDeadline('recall', this.config.recall.timeoutMs, async (signal) => {
      const body = this.buildRecallBody(query, options.maxResults);
      const res = await fetch(`${this.baseURL}/v1/recall`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(await formatHttpError('recall', res));
      const data = await res.json() as { memories?: PersistioMemory[]; related_memories?: PersistioMemory[] };
      return {
        memories: Array.isArray(data.memories) ? data.memories : [],
        relatedMemories: Array.isArray(data.related_memories) ? data.related_memories : [],
      };
    });
  }

  async recallBundle(query: string): Promise<RecallBundleResponse> {
    return withRequestDeadline('recallBundle', this.config.recall.timeoutMs, async (signal) => {
      const body = {
        ...this.buildRecallBody(query, this.config.recall.maxResults),
      };
      const res = await fetch(`${this.baseURL}/v1/recall?format=bundle`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(await formatHttpError('recallBundle', res));
      return await res.json() as RecallBundleResponse;
    });
  }

  async ingest(sessionId: string, chunks: IngestChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await withRequestDeadline('ingest', this.config.capture.timeoutMs, async (signal) => {
      const res = await fetch(`${this.baseURL}/v1/ingest`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ session_id: sessionId, chunks }),
        signal,
      });
      if (!res.ok) throw new Error(await formatHttpError('ingest', res));
    });
  }

  async storeMemory(data: string, subject: string): Promise<PersistioMemory> {
    return withRequestDeadline('memory_store', this.config.capture.timeoutMs, async (signal) => {
      const res = await fetch(`${this.baseURL}/v1/memories`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ data, subject }),
        signal,
      });
      if (!res.ok) throw new Error(await formatHttpError('memory_store', res));
      return await res.json() as PersistioMemory;
    });
  }

  async forgetMemory(id: string): Promise<void> {
    await withRequestDeadline('memory_forget', this.config.capture.timeoutMs, async (signal) => {
      const res = await fetch(`${this.baseURL}/v1/memories/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.headers(),
        signal,
      });
      if (!res.ok) throw new Error(await formatHttpError('memory_forget', res));
    });
  }

  private buildRecallBody(query: string, maxResults = this.config.recall.maxResults): Record<string, unknown> {
    const body: Record<string, unknown> = {
      query,
      top_k: maxResults,
      include_pending: this.config.recall.includePending,
      include_related: this.config.recall.includeRelated,
    };
    if (typeof this.config.recall.minSimilarity === 'number') {
      body.min_similarity = this.config.recall.minSimilarity;
    }
    return body;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }
}

export async function withRequestDeadline<T>(
  operation: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return run(new AbortController().signal);
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new PersistioTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([run(controller.signal), deadline]);
  } catch (err) {
    if (controller.signal.aborted && isAbortLikeError(err)) {
      throw new PersistioTimeoutError(operation, timeoutMs);
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

async function formatHttpError(operation: string, res: Response): Promise<string> {
  let detail = '';
  try {
    detail = (await res.text()).trim().slice(0, 500);
  } catch {
    // Status code is still useful if the body cannot be read.
  }

  return detail
    ? `Persistio ${operation} failed: ${res.status} ${detail}`
    : `Persistio ${operation} failed: ${res.status}`;
}
