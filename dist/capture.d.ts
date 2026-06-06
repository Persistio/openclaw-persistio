import type { IngestChunk } from './client.js';
import type { PersistioV2Config } from './config.js';
export interface PreparedCapture {
    chunks: IngestChunk[];
    keys: string[];
    items: CaptureItem[];
}
export interface CaptureItem {
    key: string;
    chunks: IngestChunk[];
}
export interface PrepareCaptureOptions {
    shouldIncludeKey?: (key: string) => boolean;
}
export declare function prepareCapture(event: {
    messages?: unknown[];
}, cfg: PersistioV2Config, options?: PrepareCaptureOptions): PreparedCapture;
