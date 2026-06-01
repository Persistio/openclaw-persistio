export class PersistioClient {
    baseURL;
    apiKey;
    recallTopK;
    recallMinSimilarity;
    recallTimeout;
    ingestTimeout;
    constructor(config) {
        this.baseURL = config.baseURL.replace(/\/$/, '');
        this.apiKey = config.apiKey;
        this.recallTopK = config.recallTopK;
        this.recallMinSimilarity = config.recallMinSimilarity;
        this.recallTimeout = config.recallTimeout;
        this.ingestTimeout = config.ingest.timeoutMs;
    }
    headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
        };
    }
    async recall(query) {
        const body = { query, top_k: this.recallTopK, include_pending: true };
        if (typeof this.recallMinSimilarity === 'number') {
            body.min_similarity = this.recallMinSimilarity;
        }
        const res = await fetch(`${this.baseURL}/v1/recall`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.recallTimeout),
        });
        if (!res.ok)
            throw new Error(`Persistio recall failed: ${res.status}`);
        const data = await res.json();
        return data.memories ?? [];
    }
    async recallBundle(query, topK) {
        const body = { query, top_k: topK ?? this.recallTopK, include_pending: true };
        if (typeof this.recallMinSimilarity === 'number') {
            body.min_similarity = this.recallMinSimilarity;
        }
        const res = await fetch(`${this.baseURL}/v1/recall?format=bundle`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.recallTimeout),
        });
        if (!res.ok)
            throw new Error(`Persistio recallBundle failed: ${res.status}`);
        const data = await res.json();
        return data;
    }
    async ingest(sessionId, chunks) {
        if (chunks.length === 0)
            return;
        const res = await fetch(`${this.baseURL}/v1/ingest`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ session_id: sessionId, chunks }),
            signal: AbortSignal.timeout(this.ingestTimeout),
        });
        if (!res.ok)
            throw new Error(await formatHttpError('ingest', res));
    }
    async addMemory(data, subject) {
        const res = await fetch(`${this.baseURL}/v1/memories`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ data, subject }),
        });
        if (!res.ok)
            throw new Error(`Persistio addMemory failed: ${res.status}`);
    }
    async deleteMemory(id) {
        const res = await fetch(`${this.baseURL}/v1/memories/${id}`, {
            method: 'DELETE',
            headers: this.headers(),
        });
        if (!res.ok)
            throw new Error(`Persistio deleteMemory failed: ${res.status}`);
    }
    async getMemory(id, options = {}) {
        const query = options.includePending ? '?include_pending=true' : '';
        const res = await fetch(`${this.baseURL}/v1/memories/${id}${query}`, {
            headers: this.headers(),
        });
        if (res.status === 404)
            return null;
        if (!res.ok)
            throw new Error(`Persistio getMemory failed: ${res.status}`);
        return await res.json();
    }
    async listMemories() {
        const res = await fetch(`${this.baseURL}/v1/memories`, {
            headers: this.headers(),
        });
        if (!res.ok)
            throw new Error(`Persistio listMemories failed: ${res.status}`);
        const data = await res.json();
        return data.items ?? [];
    }
}
async function formatHttpError(operation, res) {
    let detail = '';
    try {
        detail = (await res.text()).trim().slice(0, 500);
    }
    catch {
        // Ignore response body read failures; the status is still actionable.
    }
    return detail
        ? `Persistio ${operation} failed: ${res.status} ${detail}`
        : `Persistio ${operation} failed: ${res.status}`;
}
