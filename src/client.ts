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

export class PersistioTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Persistio ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export class PersistioClient {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly recallTopK: number;
  private readonly recallMinSimilarity?: number;
  private readonly recallTimeout: number;
  private readonly recallIncludePending: boolean;
  private readonly includeRelatedMemories: boolean;
  private readonly ingestTimeout: number;
  private readonly writeTimeout: number;

  constructor(config: PersistioConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.recallTopK = config.recallTopK;
    this.recallMinSimilarity = config.recallMinSimilarity;
    this.recallTimeout = config.recallTimeout;
    this.recallIncludePending = config.recallIncludePending;
    this.includeRelatedMemories = config.includeRelatedMemories;
    this.ingestTimeout = config.ingest.timeoutMs;
    this.writeTimeout = config.ingest.timeoutMs;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  async recall(query: string): Promise<PersistioMemory[]> {
    return withRequestDeadline('recall', this.recallTimeout, async (signal) => {
      const body: Record<string, unknown> = {
        query,
        top_k: this.recallTopK,
        include_pending: this.recallIncludePending
      };
      if (typeof this.recallMinSimilarity === 'number') {
        body.min_similarity = this.recallMinSimilarity;
      }

      const res = await fetch(`${this.baseURL}/v1/recall`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(`Persistio recall failed: ${res.status}`);
      const data = await res.json() as { memories: PersistioMemory[] };
      return data.memories ?? [];
    });
  }

  async recallBundle(query: string, topK?: number, options: RecallBundleOptions = {}): Promise<RecallBundleResponse> {
    return withRequestDeadline('recallBundle', this.recallTimeout, async (signal) => {
      const body: Record<string, unknown> = {
        query,
        top_k: topK ?? this.recallTopK,
        include_pending: this.recallIncludePending,
        include_related: options.includeRelated ?? this.includeRelatedMemories
      };
      if (typeof this.recallMinSimilarity === 'number') {
        body.min_similarity = this.recallMinSimilarity;
      }

      const res = await fetch(`${this.baseURL}/v1/recall?format=bundle`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(`Persistio recallBundle failed: ${res.status}`);
      const data = await res.json() as RecallBundleResponse;
      return data;
    });
  }

  async ingest(sessionId: string, chunks: Array<{ role: string; content: string; timestamp: string }>): Promise<void> {
    if (chunks.length === 0) return;
    await withRequestDeadline('ingest', this.ingestTimeout, async (signal) => {
      const res = await fetch(`${this.baseURL}/v1/ingest`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ session_id: sessionId, chunks }),
        signal,
      });
      if (!res.ok) throw new Error(await formatHttpError('ingest', res));
    });
  }

  async addMemory(data: string, subject: string): Promise<void> {
    await withRequestDeadline('addMemory', this.writeTimeout, async (signal) => {
      const res = await fetch(`${this.baseURL}/v1/memories`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ data, subject }),
        signal,
      });
      if (!res.ok) throw new Error(`Persistio addMemory failed: ${res.status}`);
    });
  }

  async deleteMemory(id: string): Promise<void> {
    await withRequestDeadline('deleteMemory', this.writeTimeout, async (signal) => {
      const res = await fetch(`${this.baseURL}/v1/memories/${id}`, {
        method: 'DELETE',
        headers: this.headers(),
        signal,
      });
      if (!res.ok) throw new Error(`Persistio deleteMemory failed: ${res.status}`);
    });
  }

  async getMemory(id: string, options: GetMemoryOptions = {}): Promise<PersistioMemory | null> {
    return withRequestDeadline('getMemory', this.recallTimeout, async (signal) => {
      const query = options.includePending ? '?include_pending=true' : '';
      const res = await fetch(`${this.baseURL}/v1/memories/${id}${query}`, {
        headers: this.headers(),
        signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Persistio getMemory failed: ${res.status}`);
      return await res.json() as PersistioMemory;
    });
  }

  async listMemories(): Promise<PersistioMemory[]> {
    return withRequestDeadline('listMemories', this.recallTimeout, async (signal) => {
      const res = await fetch(`${this.baseURL}/v1/memories`, {
        headers: this.headers(),
        signal,
      });
      if (!res.ok) throw new Error(`Persistio listMemories failed: ${res.status}`);
      const data = await res.json() as { items: PersistioMemory[] };
      return data.items ?? [];
    });
  }
}

async function withRequestDeadline<T>(
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
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

async function formatHttpError(operation: string, res: Response): Promise<string> {
  let detail = '';
  try {
    detail = (await res.text()).trim().slice(0, 500);
  } catch {
    // Ignore response body read failures; the status is still actionable.
  }

  return detail
    ? `Persistio ${operation} failed: ${res.status} ${detail}`
    : `Persistio ${operation} failed: ${res.status}`;
}
