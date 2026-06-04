/**
 * HTTP client for docling-serve's `/v1/convert/source` endpoint.
 * Dependency-free (global `fetch`, Node 20+).
 */
import type { ConvertOptions, ConvertedDocument, FileSource, IngestConfig } from './types.js';
import { buildFileRequest, buildUrlRequest, normalizeResponse, type ConvertRequest } from './payload.js';

export class DoclingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'DoclingError';
  }
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type FetchLike = typeof fetch;

export class DoclingClient {
  constructor(
    private readonly config: IngestConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Convert a user-supplied file (base64). */
  convertFile(file: FileSource, opts: ConvertOptions = {}): Promise<ConvertedDocument> {
    return this.convert(buildFileRequest(file, opts, this.config), opts.signal);
  }

  /** Convert a document by URL (e.g. an imported Canvas page asset). */
  convertUrl(url: string, opts: ConvertOptions = {}): Promise<ConvertedDocument> {
    return this.convert(buildUrlRequest(url, opts, this.config), opts.signal);
  }

  private async convert(body: ConvertRequest, signal?: AbortSignal): Promise<ConvertedDocument> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.baseUrl + '/v1/convert/source', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: withTimeout(signal, this.config.timeoutMs),
      });
    } catch (err) {
      throw new DoclingError(`Conversion request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new DoclingError(`docling-serve returned ${res.status}`, res.status, text);
    }
    return normalizeResponse(await res.json());
  }
}
