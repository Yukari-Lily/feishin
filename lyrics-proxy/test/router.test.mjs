import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { callWorker, installCache, jsonResponse, mockFetch } from './helpers.mjs';

const LRCLIB_SEARCH_FIXTURE = [
    {
        artistName: '周杰伦',
        duration: 270,
        id: 7976416,
        name: '晴天',
        plainLyrics: 'plain',
        syncedLyrics: '[00:01.00] 故事的小黃花',
    },
    {
        artistName: '周杰伦',
        duration: 270,
        id: 34863997,
        name: '晴天',
        plainLyrics: 'plain only',
        syncedLyrics: null,
    },
];

let originalFetch;

beforeEach(() => {
    originalFetch = globalThis.fetch;
    installCache();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('routing', () => {
    it('reports health and enabled sources', async () => {
        const { body, status } = await callWorker('/health');
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.deepEqual(body.sources, ['genius', 'lrclib', 'netease', 'simpmusic']);
    });

    it('lists usage at the root', async () => {
        const { body, status } = await callWorker('/');
        assert.equal(status, 200);
        assert.ok(body.endpoints['/search']);
        assert.equal(body.sources.find((entry) => entry.slug === 'lrclib').feishinSource, 'lrclib.net');
    });

    it('answers preflight with CORS headers', async () => {
        const { headers, status } = await callWorker('/search', { method: 'OPTIONS' });
        assert.equal(status, 204);
        assert.equal(headers.get('access-control-allow-origin'), '*');
        assert.match(headers.get('access-control-allow-methods'), /GET/);
    });

    it('honours ALLOWED_ORIGIN', async () => {
        const { headers } = await callWorker('/health', { env: { ALLOWED_ORIGIN: 'https://music.example.com' } });
        assert.equal(headers.get('access-control-allow-origin'), 'https://music.example.com');
    });

    it('rejects unknown paths and methods', async () => {
        assert.equal((await callWorker('/nope')).status, 404);
        assert.equal((await callWorker('/search', { method: 'POST' })).status, 405);
    });

    it('validates the source parameter', async () => {
        const missing = await callWorker('/search');
        assert.equal(missing.status, 400);
        assert.match(missing.body.error, /expected one of: genius, lrclib, netease, simpmusic/);

        const unknown = await callWorker('/search?source=tidal&name=x');
        assert.equal(unknown.status, 404);
    });

    it('validates search parameters', async () => {
        const { body, status } = await callWorker('/search?source=lrclib');
        assert.equal(status, 400);
        assert.match(body.error, /at least one of "name" or "artist"/);
    });

    it('refuses sources disabled by ENABLED_SOURCES', async () => {
        const { status } = await callWorker('/search?source=genius&name=x', {
            env: { ENABLED_SOURCES: 'lrclib,netease' },
        });
        assert.equal(status, 403);
    });

    it('ignores unknown slugs in ENABLED_SOURCES', async () => {
        const { body } = await callWorker('/health', { env: { ENABLED_SOURCES: 'lrclib, typo' } });
        assert.deepEqual(body.sources, ['lrclib']);
    });
});

describe('search', () => {
    it('normalizes LRCLib results and tags the Feishin source name', async () => {
        mockFetch([{ match: 'lrclib.net/api/search', respond: LRCLIB_SEARCH_FIXTURE }]);

        const { body, headers, status } = await callWorker('/search?source=lrclib&name=晴天&artist=周杰伦');
        assert.equal(status, 200);
        assert.equal(body.source, 'lrclib.net');
        assert.equal(body.results.length, 2);
        assert.deepEqual(body.results[0], {
            artist: '周杰伦',
            id: '7976416',
            isSync: true,
            name: '晴天',
        });
        assert.equal(body.results[1].isSync, false);
        assert.equal(headers.get('access-control-allow-origin'), '*');
    });

    it('sends the LRCLib query the same way the desktop provider does', async () => {
        const calls = mockFetch([{ match: 'lrclib.net/api/search', respond: [] }]);

        await callWorker('/search?source=lrclib&name=晴天&artist=周杰伦');
        const url = new URL(calls[0].url);
        assert.equal(url.searchParams.get('q'), '晴天 周杰伦');
        assert.match(calls[0].init.headers['User-Agent'], /feishin-lyrics-worker/);
    });

    it('searches SimpMusic by track name only', async () => {
        const calls = mockFetch([
            {
                match: 'api-lyrics.simpmusic.org/v1/search',
                respond: {
                    data: [
                        {
                            artistName: '周杰伦',
                            songTitle: '晴天',
                            syncedLyrics: null,
                            videoId: 'DYptgVvkVLQ',
                        },
                    ],
                    success: true,
                },
            },
        ]);

        const { body } = await callWorker('/search?source=simpmusic&name=晴天&artist=周杰伦');
        assert.equal(new URL(calls[0].url).searchParams.get('q'), '晴天');
        assert.deepEqual(body.results[0], {
            artist: '周杰伦',
            id: 'DYptgVvkVLQ',
            isSync: false,
            name: '晴天',
        });
    });

    it('caches responses at the edge', async () => {
        const calls = mockFetch([{ match: 'lrclib.net/api/search', respond: LRCLIB_SEARCH_FIXTURE }]);

        const first = await callWorker('/search?source=lrclib&name=晴天&artist=周杰伦');
        const second = await callWorker('/search?source=lrclib&name=晴天&artist=周杰伦');

        assert.equal(first.headers.get('x-lyrics-cache'), 'MISS');
        assert.equal(second.headers.get('x-lyrics-cache'), 'HIT');
        assert.equal(calls.length, 1);
        assert.deepEqual(second.body.results, first.body.results);
    });

    it('does not cache upstream failures', async () => {
        const calls = mockFetch([
            {
                match: 'lrclib.net/api/search',
                respond: () => jsonResponse({ error: 'boom' }, 503),
            },
        ]);

        const first = await callWorker('/search?source=lrclib&name=晴天&artist=周杰伦');
        const second = await callWorker('/search?source=lrclib&name=晴天&artist=周杰伦');

        assert.equal(first.status, 502);
        assert.match(first.body.error, /search failed for lrclib/);
        assert.equal(second.status, 502);
        assert.equal(calls.length, 2);
    });

    it('survives providers that return no matches', async () => {
        mockFetch([{ match: 'lrclib.net/api/search', respond: [] }]);
        const { body, status } = await callWorker('/search?source=lrclib&name=nothing');
        assert.equal(status, 200);
        assert.deepEqual(body.results, []);
    });
});

describe('get', () => {
    it('returns lyrics for a remote id', async () => {
        mockFetch([
            {
                match: 'lrclib.net/api/get/7976416',
                respond: { id: 7976416, plainLyrics: 'plain', syncedLyrics: '[00:01.00] line' },
            },
        ]);

        const { body, status } = await callWorker('/get?source=lrclib&id=7976416');
        assert.equal(status, 200);
        assert.equal(body.source, 'lrclib.net');
        assert.equal(body.id, '7976416');
        assert.equal(body.lyrics, '[00:01.00] line');
    });

    it('requires an id', async () => {
        const { body, status } = await callWorker('/get?source=lrclib');
        assert.equal(status, 400);
        assert.match(body.error, /missing "id"/);
    });

    it('caches per id', async () => {
        const calls = mockFetch([
            {
                match: 'lrclib.net/api/get/',
                respond: { plainLyrics: 'plain', syncedLyrics: null },
            },
        ]);

        await callWorker('/get?source=lrclib&id=1');
        await callWorker('/get?source=lrclib&id=1');
        await callWorker('/get?source=lrclib&id=2');
        assert.equal(calls.length, 2);
    });

    it('forwards the translate flag to NetEase', async () => {
        const calls = mockFetch([
            {
                match: 'music.163.com/api/song/lyric',
                respond: {
                    lrc: { lyric: '[00:10.00]original' },
                    tlyric: { lyric: '[00:10.00]translated' },
                },
            },
        ]);

        const { body } = await callWorker('/get?source=netease&id=123&translate=1');
        assert.equal(body.lyrics, '[00:10.00]original_BREAK_translated');
        assert.equal(calls.length, 1);
    });
});
