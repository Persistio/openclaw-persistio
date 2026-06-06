export class PersistioTimeoutError extends Error {
    constructor(operation, timeoutMs) {
        super(`Persistio ${operation} timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}
export class PersistioClient {
    config;
    baseURL;
    apiKey;
    constructor(config) {
        this.config = config;
        this.baseURL = config.baseURL.replace(/\/$/, '');
        this.apiKey = config.apiKey;
    }
    async recall(query, options = {}) {
        return withRequestDeadline('recall', this.config.recall.timeoutMs, async (signal) => {
            const body = this.buildRecallBody(query, options.maxResults);
            const res = await fetch(`${this.baseURL}/v1/recall`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(body),
                signal,
            });
            if (!res.ok)
                throw new Error(await formatHttpError('recall', res));
            const data = await res.json();
            return {
                memories: Array.isArray(data.memories) ? data.memories : [],
                relatedMemories: Array.isArray(data.related_memories) ? data.related_memories : [],
            };
        });
    }
    async recallBundle(query) {
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
            if (!res.ok)
                throw new Error(await formatHttpError('recallBundle', res));
            return await res.json();
        });
    }
    async ingest(sessionId, chunks) {
        if (chunks.length === 0)
            return;
        await withRequestDeadline('ingest', this.config.capture.timeoutMs, async (signal) => {
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
    async storeMemory(data, subject) {
        return withRequestDeadline('memory_store', this.config.capture.timeoutMs, async (signal) => {
            const res = await fetch(`${this.baseURL}/v1/memories`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ data, subject }),
                signal,
            });
            if (!res.ok)
                throw new Error(await formatHttpError('memory_store', res));
            return await res.json();
        });
    }
    async forgetMemory(id) {
        await withRequestDeadline('memory_forget', this.config.capture.timeoutMs, async (signal) => {
            const res = await fetch(`${this.baseURL}/v1/memories/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                headers: this.headers(),
                signal,
            });
            if (!res.ok)
                throw new Error(await formatHttpError('memory_forget', res));
        });
    }
    buildRecallBody(query, maxResults = this.config.recall.maxResults) {
        const body = {
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
    headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
        };
    }
}
export async function withRequestDeadline(operation, timeoutMs, run) {
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
    return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
async function formatHttpError(operation, res) {
    let detail = '';
    try {
        detail = (await res.text()).trim().slice(0, 500);
    }
    catch {
        // Status code is still useful if the body cannot be read.
    }
    return detail
        ? `Persistio ${operation} failed: ${res.status} ${detail}`
        : `Persistio ${operation} failed: ${res.status}`;
}
