/**
 * Single fetch wrapper used by every namespaced API module. Centralizes
 *  - URL construction (apiUrl + path + query)
 *  - JSON encoding/decoding
 *  - Error envelope mapping → typed OspexAPIError
 *  - Network-level failure mapping (timeout, DNS, etc.)
 *
 * Each `request<T>` call returns the parsed body on 2xx and throws on
 * anything else. The wrapper does not retry — callers decide.
 */

import { OspexAPIError } from '../errors.js';
import type { ApiErrorBody } from './types.js';

export interface ApiClientOptions {
  apiUrl: string;
  /** Optional override for `globalThis.fetch` — used by tests. */
  fetch?: typeof globalThis.fetch;
  /** Default abort timeout in ms. Undefined disables. */
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Extra request headers (Accept + Content-Type are set automatically). */
  headers?: Record<string, string>;
  /** Per-request timeout override. */
  timeoutMs?: number;
  /** Per-request abort signal. */
  signal?: AbortSignal;
}

export class ApiClient {
  readonly apiUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(options: ApiClientOptions) {
    if (!options.apiUrl) {
      throw new Error('ApiClient: apiUrl is required');
    }
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = options.timeoutMs;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: RequestInit['body'] | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    // Caller-supplied headers last so they can override Accept /
    // Content-Type if needed (rare, but supported).
    if (options.headers !== undefined) {
      for (const [k, v] of Object.entries(options.headers)) {
        headers[k] = v;
      }
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    const userSignal = options.signal;
    const onUserAbort = (): void => controller.abort(userSignal?.reason);
    if (userSignal !== undefined) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else userSignal.addEventListener('abort', onUserAbort, { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new OspexAPIError(networkErrorMessage(err), {
        path,
        cause: err,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (userSignal !== undefined) userSignal.removeEventListener('abort', onUserAbort);
    }

    if (!response.ok) {
      const errBody = await safeParseError(response);
      throw new OspexAPIError(errBody.error, {
        status: response.status,
        ...(errBody.code !== undefined ? { apiCode: errBody.code } : {}),
        path,
      });
    }

    // 204 No Content — return undefined cast as T (rare path; nothing in M1
    // hits this but DELETE could in M2).
    if (response.status === 204) {
      return undefined as T;
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new OspexAPIError('Failed to parse JSON response', {
        status: response.status,
        path,
        cause: err,
      });
    }
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(this.apiUrl + normalized);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
}

async function safeParseError(response: Response): Promise<ApiErrorBody> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (typeof body?.error === 'string') {
      return {
        error: body.error,
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
      };
    }
  } catch {
    // fall through
  }
  return { error: `HTTP ${response.status} ${response.statusText}`.trim() };
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'Request aborted';
    return `Network error: ${err.message}`;
  }
  return 'Network error';
}
