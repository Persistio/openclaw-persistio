export class PersistioTimeoutError extends Error {
    constructor(operation, timeoutMs) {
        super(`Persistio ${operation} timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}
export class PersistioClient {
    baseURL;
    apiKey;
    recallTopK;
    recallMinSimilarity;
    recallTimeout;
    ingestTimeout;
    writeTimeout;
    constructor(config) {
        this.baseURL = config.baseURL.replace(/\/$/, '');
        this.apiKey = config.apiKey;
        this.recallTopK = config.recallTopK;
        this.recallMinSimilarity = config.recallMinSimilarity;
        this.recallTimeout = config.recallTimeout;
        this.ingestTimeout = config.ingest.timeoutMs;
        this.writeTimeout = config.ingest.timeoutMs;
    }
    headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
        };
    }
    async recall(query) {
        return withRequestDeadline('recall', this.recallTimeout, async (signal) => {
            const body = { query, top_k: this.recallTopK, include_pending: true };
            if (typeof this.recallMinSimilarity === 'number') {
                body.min_similarity = this.recallMinSimilarity;
            }
            const res = await fetch(`${this.baseURL}/v1/recall`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(body),
                signal,
            });
            if (!res.ok)
                throw new Error(`Persistio recall failed: ${res.status}`);
            const data = await res.json();
            return data.memories ?? [];
        });
    }
    async recallBundle(query, topK) {
        return withRequestDeadline('recallBundle', this.recallTimeout, async (signal) => {
            const body = { query, top_k: topK ?? this.recallTopK, include_pending: true };
            if (typeof this.recallMinSimilarity === 'number') {
                body.min_similarity = this.recallMinSimilarity;
            }
            const res = await fetch(`${this.baseURL}/v1/recall?format=bundle`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(body),
                signal,
            });
            if (!res.ok)
                throw new Error(`Persistio recallBundle failed: ${res.status}`);
            const data = await res.json();
            return data;
        });
    }
    async ingest(sessionId, chunks) {
        if (chunks.length === 0)
            return;
        await withRequestDeadline('ingest', this.ingestTimeout, async (signal) => {
            const res = await fetch(`${this.baseURL}/v1/ingest`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ session_id: sessionId, chunks }),
                signal,
            });
            if (!res.ok)
                throw new Error(await formatHttpError('ingest', res));
        });
    }
    async addMemory(data, subject) {
        await withRequestDeadline('addMemory', this.writeTimeout, async (signal) => {
            const res = await fetch(`${this.baseURL}/v1/memories`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ data, subject }),
                signal,
            });
            if (!res.ok)
                throw new Error(`Persistio addMemory failed: ${res.status}`);
        });
    }
    async deleteMemory(id) {
        await withRequestDeadline('deleteMemory', this.writeTimeout, async (signal) => {
            const res = await fetch(`${this.baseURL}/v1/memories/${id}`, {
                method: 'DELETE',
                headers: this.headers(),
                signal,
            });
            if (!res.ok)
                throw new Error(`Persistio deleteMemory failed: ${res.status}`);
        });
    }
    async getMemory(id, options = {}) {
        return withRequestDeadline('getMemory', this.recallTimeout, async (signal) => {
            const query = options.includePending ? '?include_pending=true' : '';
            const res = await fetch(`${this.baseURL}/v1/memories/${id}${query}`, {
                headers: this.headers(),
                signal,
            });
            if (res.status === 404)
                return null;
            if (!res.ok)
                throw new Error(`Persistio getMemory failed: ${res.status}`);
            return await res.json();
        });
    }
    async listMemories() {
        return withRequestDeadline('listMemories', this.recallTimeout, async (signal) => {
            const res = await fetch(`${this.baseURL}/v1/memories`, {
                headers: this.headers(),
                signal,
            });
            if (!res.ok)
                throw new Error(`Persistio listMemories failed: ${res.status}`);
            const data = await res.json();
            return data.items ?? [];
        });
    }
}
async function withRequestDeadline(operation, timeoutMs, run) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return run(new AbortController().signal);
    }
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_resolve, reject) => {
        timeout = setTimeout(() => {
            controller.abort();
            reject(new PersistioTimeoutError(operation, timeoutMs));
        }, timeoutMs);
    });
    try {
        return await Promise.race([run(controller.signal), deadline]);
    }
    catch (err) {
        if (controller.signal.aborted && isAbortLikeError(err)) {
            throw new PersistioTimeoutError(operation, timeoutMs);
        }
        throw err;
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
function isAbortLikeError(err) {
    if (!(err instanceof Error))
        return false;
    return err.name === 'AbortError' || err.name === 'TimeoutError';
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
