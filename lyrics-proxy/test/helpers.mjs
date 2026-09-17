/**
 * Shared helpers for the test suite.
 *
 * The worker is plain ESM with no workerd-only APIs on the module path, so
 * the whole thing can be exercised under `node --test` by stubbing the two
 * globals a worker normally gets for free: `fetch` and `caches`.
 */

import worker from '../src/index.js';

const cacheStoreKey = (request) => (typeof request === 'string' ? request : request.url);

/** Installs a minimal Cache API shim that survives repeated reads. */
export function installCache() {
    const store = new Map();

    globalThis.caches = {
        default: {
            _store: store,
            async match(request) {
                const entry = store.get(cacheStoreKey(request));
                return entry ? entry.clone() : undefined;
            },
            async put(request, response) {
                store.set(cacheStoreKey(request), response.clone());
            },
        },
    };

    return store;
}

/**
 * Replaces global fetch.
 *
 * @param {Array<{match: RegExp|string|((url: string, init: object) => boolean), respond: any}>} routes
 *   `respond` may be a plain object (JSON), a string (HTML), a Response, or a
 *   function returning any of those.
 */
export function mockFetch(routes) {
    const calls = [];

    globalThis.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push({ init, url });

        for (const route of routes) {
            const matcher = route.match;
            const matched =
                typeof matcher === 'function'
                    ? matcher(url, init)
                    : matcher instanceof RegExp
                      ? matcher.test(url)
                      : url.includes(matcher);

            if (!matched) continue;

            const value = typeof route.respond === 'function' ? await route.respond(url, init) : route.respond;
            if (value instanceof Response) return value;
            if (typeof value === 'string') {
                return new Response(value, {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    status: 200,
                });
            }
            return jsonResponse(value);
        }

        throw new Error(`unexpected fetch: ${init.method ?? 'GET'} ${url}`);
    };

    return calls;
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        status,
    });
}

export function textResponse(body, status = 200) {
    return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status });
}

/** Calls the worker's fetch handler with a synthetic Cloudflare context. */
export async function callWorker(path, { env = {}, method = 'GET' } = {}) {
    const waits = [];
    const ctx = { waitUntil: (promise) => waits.push(promise) };
    const request = new Request(`https://worker.test${path}`, { method });

    const response = await worker.fetch(request, env, ctx);
    await Promise.allSettled(waits);

    const text = await response.text();
    let body = null;
    try {
        body = JSON.parse(text);
    } catch {
        body = null;
    }

    return { body, headers: response.headers, status: response.status, text };
}
