export class PersistioClient {
    baseURL;
    apiKey;
    recallTopK;
    recallTimeout;
    constructor(config) {
        this.baseURL = config.baseURL.replace(/\/$/, '');
        this.apiKey = config.apiKey;
        this.recallTopK = config.recallTopK;
        this.recallTimeout = config.recallTimeout;
    }
    headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
        };
    }
    async recall(query, topK) {
        const res = await fetch(`${this.baseURL}/v1/recall`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ query, top_k: topK ?? this.recallTopK }),
            signal: AbortSignal.timeout(this.recallTimeout),
        });
        if (!res.ok)
            throw new Error(`Persistio recall failed: ${res.status}`);
        const data = await res.json();
        return data.memories ?? [];
    }
    async recallBundle(query, topK) {
        const res = await fetch(`${this.baseURL}/v1/recall?format=bundle`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ query, top_k: topK ?? this.recallTopK }),
            signal: AbortSignal.timeout(this.recallTimeout),
        });
        if (!res.ok)
            throw new Error(`Persistio recallBundle failed: ${res.status}`);
        const data = await res.json();
        return data.bundle;
    }
    async ingest(sessionId, chunks) {
        if (chunks.length === 0)
            return;
        const res = await fetch(`${this.baseURL}/v1/ingest`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ session_id: sessionId, chunks }),
        });
        if (!res.ok)
            throw new Error(`Persistio ingest failed: ${res.status}`);
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
