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
 *
 * Source slugs: lrclib | netease | simpmusic | genius
 */

import { PROVIDERS, PROVIDER_SLUGS, resolveEnabledSources } from './providers/index.js';
import { readTranslationLines, translateLines, translationEnabled } from './translation.js';

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
                return badRequest('expected up to 300 lyric lines (20,000 characters)', env);
            }
            const response = json(
                {
                    lines: await translateLines(translationRequest.lines, env, translationRequest),
                },
                { env },
            );
            response.headers.set('Cache-Control', 'no-store');
            return response;
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
                        '/translate': 'POST /translate { lines: string[] }',
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
