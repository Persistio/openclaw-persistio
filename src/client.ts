export interface PersistioConfig {
  baseURL: string;
  apiKey: string;
  tokenBudget: number;
  recallTopK: number;
  recallMinSimilarity?: number;
  recallTimeout: number;
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

export class PersistioClient {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly recallTopK: number;
  private readonly recallMinSimilarity?: number;
  private readonly recallTimeout: number;

  constructor(config: PersistioConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.recallTopK = config.recallTopK;
    this.recallMinSimilarity = config.recallMinSimilarity;
    this.recallTimeout = config.recallTimeout;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  async recall(query: string): Promise<PersistioMemory[]> {
    const body: Record<string, unknown> = { query, top_k: this.recallTopK, include_pending: true };
    if (typeof this.recallMinSimilarity === 'number') {
      body.min_similarity = this.recallMinSimilarity;
    }

    const res = await fetch(`${this.baseURL}/v1/recall`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.recallTimeout),
    });
    if (!res.ok) throw new Error(`Persistio recall failed: ${res.status}`);
    const data = await res.json() as { memories: PersistioMemory[] };
    return data.memories ?? [];
  }

  async recallBundle(query: string, topK?: number): Promise<RecallBundleResponse> {
    const body: Record<string, unknown> = { query, top_k: topK ?? this.recallTopK, include_pending: true };
    if (typeof this.recallMinSimilarity === 'number') {
      body.min_similarity = this.recallMinSimilarity;
    }

    const res = await fetch(`${this.baseURL}/v1/recall?format=bundle`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.recallTimeout),
    });
    if (!res.ok) throw new Error(`Persistio recallBundle failed: ${res.status}`);
    const data = await res.json() as RecallBundleResponse;
    return data;
  }

  async ingest(sessionId: string, chunks: Array<{ role: string; content: string; timestamp: string }>): Promise<void> {
    if (chunks.length === 0) return;
    const res = await fetch(`${this.baseURL}/v1/ingest`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ session_id: sessionId, chunks }),
    });
    if (!res.ok) throw new Error(`Persistio ingest failed: ${res.status}`);
  }

  async addMemory(data: string, subject: string): Promise<void> {
    const res = await fetch(`${this.baseURL}/v1/memories`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ data, subject }),
    });
    if (!res.ok) throw new Error(`Persistio addMemory failed: ${res.status}`);
  }

  async deleteMemory(id: string): Promise<void> {
    const res = await fetch(`${this.baseURL}/v1/memories/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Persistio deleteMemory failed: ${res.status}`);
  }

  async getMemory(id: string, options: GetMemoryOptions = {}): Promise<PersistioMemory | null> {
    const query = options.includePending ? '?include_pending=true' : '';
    const res = await fetch(`${this.baseURL}/v1/memories/${id}${query}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Persistio getMemory failed: ${res.status}`);
    return await res.json() as PersistioMemory;
  }

  async listMemories(): Promise<PersistioMemory[]> {
    const res = await fetch(`${this.baseURL}/v1/memories`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Persistio listMemories failed: ${res.status}`);
    const data = await res.json() as { items: PersistioMemory[] };
    return data.items ?? [];
  }
}
