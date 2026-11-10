/**
 * feishin-lyrics-worker
 *
 * A tiny CORS proxy that gives the Feishin *web* build the internet lyric
 * search that the Electron build performs in its main process.
 *
 * Feishin's renderer reaches its main process through three IPC calls:
 *
 *   window.api.lyrics.searchRemoteLyrics(params)          -> grouped search hits
 *   window.api.lyrics.getRemoteLyricsByRemoteId(query)    -> lyrics for one hit
 *   window.api.lyrics.getRemoteLyricsBySong(song)         -> best match for a song
 *
 * A web build has no main process, so the fork ships a renderer side provider
 * (src/renderer/features/lyrics/api/web-lyrics-api.ts) that talks to this
 * worker for the sources a browser cannot reach on its own. The worker
 * therefore exposes the first two primitives - search and get - and leaves
 * scoring, ranking and selection to the client, so both builds rank with the
 * same algorithm.
 *
 * Routes
 *   GET /health
 *   GET /search?source=<slug>&name=&artist=&album=&duration=
 *   GET /get?source=<slug>&id=<remoteId>[&translate=1]
 *   POST /translate { name?, artist?, lines }
 *        JSON { lines } normally, or server-sent events when the caller sends
 *        `Accept: text/event-stream`
 *
 * Source slugs: lrclib | netease | simpmusic | genius
 */

import { PROVIDERS, PROVIDER_SLUGS, resolveEnabledSources } from './providers/index.js';
import {
    readTranslationLines,
    streamTranslation,
    translationEnabled,
    translationLimits,
    translationTag,
} from './translation.js';

const VERSION = '1.0.0';
const DEFAULT_CACHE_TTL_SECONDS = 3600;
const MAX_CACHE_TTL_SECONDS = 86400;

function corsHeaders(env) {
    return {
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || '*',
        'Access-Control-Max-Age': '86400',
    };
}

function cacheTtlSeconds(env) {
    const value = Number(env?.CACHE_TTL_SECONDS);
    if (!Number.isFinite(value) || value < 0) return DEFAULT_CACHE_TTL_SECONDS;
    return Math.min(value, MAX_CACHE_TTL_SECONDS);
}

function json(data, { env, status = 200, ttl = 0 } = {}) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) };
    if (ttl > 0) headers['Cache-Control'] = `public, max-age=${ttl}`;
    return new Response(JSON.stringify(data), { headers, status });
}

function getCache() {
    return typeof caches !== 'undefined' && caches?.default ? caches.default : null;
}

/** Copies a response so the X-Lyrics-Cache header can be added safely. */
function tagCacheStatus(response, status) {
    const headers = new Headers(response.headers);
    headers.set('X-Lyrics-Cache', status);
    return new Response(response.body, { headers, status: response.status });
}

/**
 * Edge cache wrapper. The key is the worker's own URL, so no upstream or
 * cross-origin caching rules are involved.
 */
async function withCache({ ctx, env, key }, producer) {
    const ttl = cacheTtlSeconds(env);
    const cache = getCache();
    if (!cache || ttl === 0) return tagCacheStatus(await producer(), 'BYPASS');

    const cacheKey = new Request(key, { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return tagCacheStatus(hit, 'HIT');

    const response = await producer();
    if (response.status === 200) {
        const toStore = new Response(response.clone().body, {
            headers: new Headers(response.headers),
            status: response.status,
        });
        toStore.headers.set('Cache-Control', `public, max-age=${ttl}`);
        const put = cache.put(cacheKey, toStore).catch(() => {});
        if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(put);
        else await put;
    }

    return tagCacheStatus(response, 'MISS');
}

function readSearchParams(url) {
    const sp = url.searchParams;
    const rawDuration = Number(sp.get('duration'));
    const translate = ['1', 'true', 'yes'].includes((sp.get('translate') || '').toLowerCase());

    return {
        album: (sp.get('album') || '').trim() || undefined,
        artist: (sp.get('artist') || '').trim(),
        duration: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined,
        name: (sp.get('name') || sp.get('track') || sp.get('q') || '').trim(),
        translate,
    };
}

function badRequest(message, env, status = 400) {
    return json({ error: message }, { env, status });
}

/** True when the caller opted into incremental delivery. */
function wantsEventStream(request) {
    const accept = request.headers.get('accept') || '';
    return accept.includes('text/event-stream');
}

function sseEvent(name, data) {
    return `event: ${name}\ndata: ${data}\n\n`;
}

/**
 * Streams translation events as server-sent events.
 *
 * A first comment line is written immediately so a buffering proxy is easy to
 * tell apart from a slow model: on an unbuffered deployment the headers plus
 * that line arrive right away, otherwise everything shows up at the end.
 */
function translationResponse(events, abort, env) {
    const encoder = new TextEncoder();
    const iterator = events[Symbol.asyncIterator]();

    const body = new ReadableStream({
        async cancel() {
            abort.abort();
            await iterator.return?.();
        },
        async start(controller) {
            const write = (chunk) => {
                try {
                    controller.enqueue(encoder.encode(chunk));
                    return true;
                } catch {
                    return false;
                }
            };

            write(': open\n\n');
            try {
                while (true) {
                    const step = await iterator.next();
                    if (step.done) break;
                    const event = step.value;
                    const payload = event.type === 'line'
                        ? sseEvent('line', JSON.stringify({ i: event.index, t: event.text }))
                        : sseEvent('done', JSON.stringify({ lines: event.lines }));
                    if (!write(payload)) return;
                }
            } catch {
                write(sseEvent('done', JSON.stringify({ lines: null })));
            } finally {
                try {
                    controller.close();
                } catch {
                    // The client is gone.
                }
            }
        },
    });

    const headers = new Headers(corsHeaders(env));
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Type', 'text/event-stream; charset=utf-8');
    headers.set('X-Accel-Buffering', 'no');
    return new Response(body, { headers, status: 200 });
}

async function handleSearch({ ctx, env, request, url }) {
    const slug = (url.searchParams.get('source') || '').toLowerCase();
    if (!slug) return badRequest(`missing "source" parameter, expected one of: ${PROVIDER_SLUGS.join(', ')}`, env);

    const provider = PROVIDERS[slug];
    if (!provider) return badRequest(`unknown source "${slug}", expected one of: ${PROVIDER_SLUGS.join(', ')}`, env, 404);

    if (!resolveEnabledSources(env).includes(slug)) {
        return badRequest(`source "${slug}" is disabled on this deployment`, env, 403);
    }

    const params = readSearchParams(url);
    if (!params.name && !params.artist) {
        return badRequest('provide at least one of "name" or "artist"', env);
    }

    return withCache({ ctx, env, key: url.toString() }, async () => {
        try {
            const results = await provider.search(params, env);
            return json(
                { results, slug, source: provider.feishinSource },
                { env, ttl: cacheTtlSeconds(env) },
            );
        } catch (error) {
            return json(
                { error: `search failed for ${slug}: ${error?.message ?? error}`, source: provider.feishinSource },
                { env, status: 502 },
            );
        }
    });
}

async function handleGet({ ctx, env, url }) {
    const slug = (url.searchParams.get('source') || '').toLowerCase();
    if (!slug) return badRequest(`missing "source" parameter, expected one of: ${PROVIDER_SLUGS.join(', ')}`, env);

    const provider = PROVIDERS[slug];
    if (!provider) return badRequest(`unknown source "${slug}", expected one of: ${PROVIDER_SLUGS.join(', ')}`, env, 404);

    if (!resolveEnabledSources(env).includes(slug)) {
        return badRequest(`source "${slug}" is disabled on this deployment`, env, 403);
    }

    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return badRequest('missing "id" parameter', env);

    const { translate } = readSearchParams(url);

    return withCache({ ctx, env, key: url.toString() }, async () => {
        try {
            const lyrics = await provider.get(id, env, { translate });
            return json({ id, lyrics: lyrics ?? null, slug, source: provider.feishinSource }, { env, ttl: cacheTtlSeconds(env) });
        } catch (error) {
            return json(
                { error: `lyrics lookup failed for ${slug}: ${error?.message ?? error}`, source: provider.feishinSource },
                { env, status: 502 },
            );
        }
    });
}

/**
 * Per instance request limits.
 *
 * Edge runtimes start a fresh instance per concurrent request, so these counters
 * bound bursts and runaway clients on a warm instance - they are not a global
 * quota. Use a platform rate limit rule or a provider budget for that.
 */
const WINDOW_MS = 60000;
const MAX_CONCURRENT = 2;
const MAX_PER_CLIENT = 15;
const MAX_PER_INSTANCE = 30;
const MAX_TRACKED_CLIENTS = 500;

let activeTranslations = 0;
let instanceWindow = { count: 0, start: 0 };
const clientWindows = new Map();

/** Client address as reported by the platform, best effort. */
function clientKey(request) {
    const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    return (
        forwarded ||
        request.headers.get('cf-connecting-ip') ||
        request.headers.get('eo-connecting-ip') ||
        request.headers.get('x-real-ip') ||
        'unknown'
    );
}

function windowCount(entry, now) {
    if (now - entry.start > WINDOW_MS) return { count: 0, start: now };
    return entry;
}

/** Returns the seconds to wait, or 0 when the request may proceed. */
function rateLimited(key, now = Date.now()) {
    instanceWindow = windowCount(instanceWindow, now);
    if (instanceWindow.count >= MAX_PER_INSTANCE) {
        return Math.max(1, Math.ceil((WINDOW_MS - (now - instanceWindow.start)) / 1000));
    }

    const entry = clientWindows.get(key) ?? { count: 0, start: now };
    const current = windowCount(entry, now);
    if (current.count >= MAX_PER_CLIENT) {
        clientWindows.set(key, current);
        return Math.max(1, Math.ceil((WINDOW_MS - (now - current.start)) / 1000));
    }

    instanceWindow = { count: instanceWindow.count + 1, start: instanceWindow.start };
    clientWindows.set(key, { count: current.count + 1, start: current.start });
    if (clientWindows.size > MAX_TRACKED_CLIENTS) {
        clientWindows.delete(clientWindows.keys().next().value);
    }
    return 0;
}

function tooManyRequests(retryAfter, env, reason, status = 429) {
    const response = json({ error: reason, retryAfter }, { env, status });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Retry-After', String(retryAfter));
    return response;
}

/** Test hook: the counters are module state, so suites need a fresh slate. */
export function resetRateLimits() {
    activeTranslations = 0;
    instanceWindow = { count: 0, start: 0 };
    clientWindows.clear();
}

export default {
    async fetch(request, env = {}, ctx = {}) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders(env), status: 204 });
        }

        if (path === '/translate' && request.method === 'POST') {
            if (!translationEnabled(env)) return json({ lines: null }, { env });
            let translationRequest;
            try {
                translationRequest = await readTranslationLines(request);
            } catch {
                const limits = translationLimits();
                return badRequest(
                    `expected 1 to ${limits.lines} lyric lines, ${limits.lineChars} characters per line, ` +
                        `${limits.totalChars} characters in total`,
                    env,
                );
            }

            const retryAfter = rateLimited(clientKey(request));
            if (retryAfter > 0) return tooManyRequests(retryAfter, env, 'rate limited');
            if (activeTranslations >= MAX_CONCURRENT) {
                // Not the client's fault, so answer 503: the browser only backs off
                // on 429 and must stay free to translate another song right away.
                return tooManyRequests(5, env, 'translation already in progress', 503);
            }
            activeTranslations += 1;

            const abort = new AbortController();
            const incoming = request.signal;
            if (incoming) {
                if (incoming.aborted) abort.abort();
                else incoming.addEventListener('abort', () => abort.abort(), { once: true });
            }
            const events = streamTranslation(
                translationRequest.lines,
                env,
                translationRequest,
                {
                    onRelease: () => {
                        activeTranslations = Math.max(0, activeTranslations - 1);
                    },
                    signal: abort.signal,
                },
            );

            // Existing web bundles still ask for a single JSON body. They keep
            // working unchanged until they send `Accept: text/event-stream`.
            if (!wantsEventStream(request)) {
                let lines = null;
                try {
                    for await (const event of events) {
                        if (event.type === 'done') lines = event.lines;
                    }
                } catch {
                    lines = null;
                }
                const buffered = json({ lines }, { env });
                buffered.headers.set('Cache-Control', 'no-store');
                return buffered;
            }

            return translationResponse(events, abort, env);
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return json({ error: 'method not allowed' }, { env, status: 405 });
        }

        if (path === '/health') {
            return json(
                {
                    cache: getCache() ? 'edge' : 'disabled',
                    aiTranslation: translationEnabled(env),
                    ok: true,
                    service: 'feishin-lyrics-worker',
                    sources: resolveEnabledSources(env),
                    translationTag: await translationTag(env),
                    version: VERSION,
                },
                { env },
            );
        }

        if (path === '/search') return handleSearch({ ctx, env, request, url });
        if (path === '/get') return handleGet({ ctx, env, url });

        if (path === '/') {
            return json(
                {
                    endpoints: {
                        '/get': 'GET /get?source=<slug>&id=<remoteId>[&translate=1]',
                        '/health': 'GET /health',
                        '/search': 'GET /search?source=<slug>&name=&artist=&album=&duration=',
                        '/translate': 'POST /translate { lines: string[] } -> JSON, or text/event-stream when accepted',
                    },
                    service: 'feishin-lyrics-worker',
                    sources: resolveEnabledSources(env).map((slug) => ({
                        feishinSource: PROVIDERS[slug].feishinSource,
                        slug,
                    })),
                    version: VERSION,
                },
                { env },
            );
        }

        return json({ error: 'not found' }, { env, status: 404 });
    },
};
