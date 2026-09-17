/**
 * Live smoke tests - these talk to the real providers.
 *
 * They are skipped by default because they depend on third party services
 * being reachable and on the machine running them not being rate limited:
 *
 *   npm run test:live
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callWorker, installCache } from './helpers.mjs';

import * as genius from '../src/providers/genius.js';
import * as lrclib from '../src/providers/lrclib.js';
import * as netease from '../src/providers/netease.js';
import * as simpmusic from '../src/providers/simpmusic.js';

const RUN_LIVE = process.env.RUN_LIVE === '1';
const options = RUN_LIVE ? {} : { skip: 'set RUN_LIVE=1 to hit the real providers' };

describe('live worker endpoints', options, () => {
    it('serves a search and a get end to end', async () => {
        installCache();

        const search = await callWorker('/search?source=lrclib&name=晴天&artist=周杰伦');
        assert.equal(search.status, 200);
        assert.ok(search.body.results.length > 0);

        const hit = search.body.results.find((entry) => entry.isSync) ?? search.body.results[0];
        const get = await callWorker(`/get?source=lrclib&id=${encodeURIComponent(hit.id)}`);
        assert.equal(get.status, 200);
        assert.ok(get.body.lyrics && get.body.lyrics.length > 0);
    });

    it('answers /health', async () => {
        const { body, status } = await callWorker('/health');
        assert.equal(status, 200);
        assert.equal(body.ok, true);
    });
});

describe('live providers', options, () => {
    it('LRCLib returns a searchable, synced result', async () => {
        const results = await lrclib.search({ artist: '周杰伦', name: '晴天' }, {});
        assert.ok(results.length > 0, 'expected LRCLib search hits');

        const synced = results.find((entry) => entry.isSync) ?? results[0];
        const lyrics = await lrclib.get(synced.id, {});
        assert.ok(lyrics && lyrics.length > 0, 'expected LRCLib lyrics');
        assert.match(lyrics, /\[\d{2}:\d{2}/);
    });

    it('SimpMusic returns a searchable result', async () => {
        const results = await simpmusic.search({ artist: '周杰伦', name: '晴天' }, {});
        assert.ok(results.length > 0, 'expected SimpMusic search hits');

        const lyrics = await simpmusic.get(results[0].id, {});
        assert.ok(lyrics && lyrics.length > 0, 'expected SimpMusic lyrics');
    });

    it('NetEase cloudsearch returns on-topic hits', async () => {
        const results = await netease.search({ artist: '周杰伦', name: '晴天' }, {});
        assert.ok(results.length > 0, 'expected NetEase search hits');
        assert.ok(
            results.some((entry) => entry.name.includes('晴天')),
            `expected a 晴天 hit, got: ${results.map((entry) => entry.name).join(' | ')}`,
        );
    });

    it('Genius either answers or is blocked by Cloudflare', async () => {
        try {
            const results = await genius.search({ artist: 'Jay Chou', name: '晴天' }, {});
            if (results.length === 0) {
                console.warn('genius returned no hits (likely blocked for this network)');
                return;
            }
            const lyrics = await genius.get(results[0].id, {});
            assert.ok(lyrics === null || typeof lyrics === 'string');
        } catch (error) {
            console.warn(`genius unavailable from this network: ${error.message}`);
        }
    });
});
