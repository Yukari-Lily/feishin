import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { jsonResponse, mockFetch, textResponse } from './helpers.mjs';

import * as genius from '../src/providers/genius.js';
import * as lrclib from '../src/providers/lrclib.js';
import * as netease from '../src/providers/netease.js';
import * as simpmusic from '../src/providers/simpmusic.js';

let originalFetch;

beforeEach(() => {
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('lrclib', () => {
    it('maps syncedLyrics to isSync', async () => {
        mockFetch([
            {
                match: 'lrclib.net/api/search',
                respond: [
                    { artistName: 'A', id: 1, name: 'One', syncedLyrics: '[00:01.00]x' },
                    { artistName: 'B', id: 2, name: 'Two', plainLyrics: 'x', syncedLyrics: null },
                ],
            },
        ]);

        const results = await lrclib.search({ artist: 'A', name: 'One' }, {});
        assert.equal(results[0].isSync, true);
        assert.equal(results[1].isSync, false);
    });

    it('prefers synced lyrics, then plain, then nothing', async () => {
        mockFetch([
            { match: '/api/get/1', respond: { plainLyrics: 'plain', syncedLyrics: 'synced' } },
            { match: '/api/get/2', respond: { plainLyrics: 'plain', syncedLyrics: null } },
            { match: '/api/get/3', respond: { plainLyrics: null, syncedLyrics: null } },
        ]);

        assert.equal(await lrclib.get('1', {}), 'synced');
        assert.equal(await lrclib.get('2', {}), 'plain');
        assert.equal(await lrclib.get('3', {}), null);
    });

    it('skips search when there is nothing to search for', async () => {
        const calls = mockFetch([{ match: 'lrclib.net', respond: [] }]);
        assert.deepEqual(await lrclib.search({}, {}), []);
        assert.equal(calls.length, 0);
    });

    it('honours a custom base url', async () => {
        const calls = mockFetch([{ match: 'lrclib.mirror.test', respond: [] }]);
        await lrclib.search({ name: 'x' }, { LRCLIB_BASE_URL: 'https://lrclib.mirror.test/' });
        assert.ok(calls[0].url.startsWith('https://lrclib.mirror.test/api/search'));
    });
});

describe('simpmusic', () => {
    it('uses the videoId as the lyric id', async () => {
        mockFetch([
            {
                match: 'v1/search',
                respond: { data: [{ artistName: 'A', songTitle: 'T', videoId: 'abc' }], success: true },
            },
        ]);

        const results = await simpmusic.search({ artist: 'A', name: 'T' }, {});
        assert.equal(results[0].id, 'abc');
    });

    it('reads the first record of the lyric payload', async () => {
        mockFetch([
            {
                match: 'v1/abc',
                respond: { data: [{ plainLyric: 'plain', syncedLyrics: null }], success: true },
            },
        ]);

        assert.equal(await simpmusic.get('abc', {}), 'plain');
    });

    it('returns null for an empty payload', async () => {
        mockFetch([{ match: 'v1/empty', respond: { data: [], success: true } }]);
        assert.equal(await simpmusic.get('empty', {}), null);
    });
});

describe('netease', () => {
    const cloudsearchPayload = {
        code: 200,
        result: {
            songs: [
                {
                    al: { name: '叶惠美' },
                    ar: [{ name: '周杰伦' }],
                    dt: 269_000,
                    id: 186016,
                    name: '晴天',
                },
            ],
        },
    };

    it('normalizes the cloudsearch shape', async () => {
        mockFetch([{ match: 'cloudsearch/pc', respond: cloudsearchPayload }]);

        const results = await netease.search({ artist: '周杰伦', name: '晴天' }, {});
        assert.deepEqual(results[0], {
            album: '叶惠美',
            artist: '周杰伦',
            duration: 269,
            id: '186016',
            isSync: null,
            name: '晴天',
        });
    });

    it('falls back to the legacy endpoint when cloudsearch is empty', async () => {
        const calls = mockFetch([
            { match: 'cloudsearch/pc', respond: { code: 200, result: {} } },
            {
                match: 'api/search/get',
                respond: {
                    code: 200,
                    result: {
                        songs: [{ album: { name: 'Album' }, artists: [{ name: 'Artist' }], duration: 200_000, id: 42, name: 'Song' }],
                    },
                },
            },
        ]);

        const results = await netease.search({ artist: 'Artist', name: 'Song' }, {});
        assert.equal(calls.length, 2);
        assert.equal(results[0].id, '42');
        assert.equal(results[0].artist, 'Artist');
        assert.equal(results[0].duration, 200);
    });

    it('falls back to the legacy endpoint when cloudsearch throws', async () => {
        const calls = mockFetch([
            { match: 'cloudsearch/pc', respond: () => jsonResponse({ error: 'nope' }, 500) },
            { match: 'api/search/get', respond: { result: { songs: [{ id: 7, name: 'S' }] } } },
        ]);

        const results = await netease.search({ artist: 'A', name: 'S' }, {});
        assert.equal(calls.length, 2);
        assert.equal(results[0].id, '7');
    });

    it('returns the original lyric by default', async () => {
        mockFetch([
            {
                match: 'song/lyric',
                respond: { lrc: { lyric: '[00:10.00]original\n[00:20.00]second' }, tlyric: { lyric: '[00:10.00]translated' } },
            },
        ]);

        const lyrics = await netease.get('1', {});
        assert.equal(lyrics, '[00:10.00]original\n[00:20.00]second');
    });

    it('merges translations with the renderer delimiter', async () => {
        mockFetch([
            {
                match: 'song/lyric',
                respond: {
                    lrc: { lyric: '[00:10.00]original\n[00:20.00]only original\nplain line' },
                    tlyric: { lyric: '[00:10.00]translated' },
                },
            },
        ]);

        const lyrics = await netease.get('1', {}, { translate: true });
        assert.equal(lyrics, '[00:10.00]original_BREAK_translated\n[00:20.00]only original\nplain line');
    });

    it('keeps the original when there is no translation payload', async () => {
        mockFetch([{ match: 'song/lyric', respond: { lrc: { lyric: '[00:10.00]original' } } }]);
        assert.equal(await netease.get('1', {}, { translate: true }), '[00:10.00]original');
    });

    it('returns null when the track has no lyric payload', async () => {
        mockFetch([{ match: 'song/lyric', respond: { code: 200, nolyric: true } }]);
        assert.equal(await netease.get('1', {}), null);
    });

    it('sends the headers NetEase requires', async () => {
        const calls = mockFetch([{ match: 'song/lyric', respond: { lrc: { lyric: 'x' } } }]);
        await netease.get('1', {});
        assert.equal(calls[0].init.headers.Referer, 'https://music.163.com/');
        assert.match(calls[0].init.headers['User-Agent'], /Mozilla/);
    });
});

describe('genius', () => {
    const searchPayload = {
        response: {
            sections: [
                {
                    hits: [
                        {
                            result: {
                                artist_names: 'Jay Chou',
                                full_title: '晴天 by Jay Chou',
                                title: '晴天',
                                url: 'https://genius.com/Jay-chou-qing-tian-lyrics',
                            },
                            type: 'song',
                        },
                        { result: { artist_names: 'x', full_title: 'broken' }, type: 'song' },
                    ],
                },
            ],
        },
    };

    it('maps search hits and drops entries without a url', async () => {
        const calls = mockFetch([{ match: 'genius.com/api/search/song', respond: searchPayload }]);

        const results = await genius.search({ artist: 'Jay Chou', name: '晴天' }, {});
        assert.equal(results.length, 1);
        assert.deepEqual(results[0], {
            artist: 'Jay Chou',
            id: 'https://genius.com/Jay-chou-qing-tian-lyrics',
            isSync: null,
            name: '晴天 by Jay Chou',
        });
        assert.equal(new URL(calls[0].url).searchParams.get('q'), 'Jay Chou 晴天');
    });

    it('extracts lyrics from the song page', async () => {
        mockFetch([
            {
                match: 'genius.com/Jay-chou-qing-tian-lyrics',
                respond: textResponse(
                    '<html><body><div data-lyrics-container="true">Line one<br/>Line two &amp; more</div></body></html>',
                ),
            },
        ]);

        const lyrics = await genius.get('https://genius.com/Jay-chou-qing-tian-lyrics', {});
        assert.equal(lyrics, 'Line one\nLine two & more');
    });

    it('surfaces upstream blocks as errors', async () => {
        mockFetch([{ match: 'genius.com/Jay-chou', respond: () => textResponse('blocked', 403) }]);
        await assert.rejects(
            () => genius.get('https://genius.com/Jay-chou-qing-tian-lyrics', {}),
            /genius responded 403/,
        );
    });

    it('refuses to follow ids pointing at another host', async () => {
        const calls = mockFetch([{ match: 'example.com', respond: 'nope' }]);
        assert.equal(await genius.get('https://example.com/evil', {}), null);
        assert.equal(await genius.get('not a url', {}), null);
        assert.equal(calls.length, 0);
    });
});
