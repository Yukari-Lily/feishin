import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import worker, { resetRateLimits } from '../src/index.js';
import { createLineScanner, streamTranslation } from '../src/translation.js';

const ENV = {
    LYRICS_AI_API_KEY: 'test-key',
    LYRICS_AI_MODEL: 'test-model',
    LYRICS_AI_URL: 'https://provider.test/v1/chat/completions',
};

let originalFetch;

beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetRateLimits();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** One Chat Completions streaming event carrying a content delta. */
function deltaEvent(content) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** An upstream response that streams `chunks` as text/event-stream. */
function sseResponse(chunks) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' }, status: 200 });
}

/** Builds the translation reply for `lines`, delivered in 1..n deltas. */
function translationStream(lines, pieces = 3) {
    const payload = JSON.stringify({ translations: lines });
    const chunks = [];
    const size = Math.max(1, Math.ceil(payload.length / pieces));
    for (let offset = 0; offset < payload.length; offset += size) {
        chunks.push(deltaEvent(payload.slice(offset, offset + size)));
    }
    chunks.push('data: [DONE]\n\n');
    return sseResponse(chunks);
}

function mockUpstream(respond) {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
        calls.push({
            body: init.body ? JSON.parse(init.body) : undefined,
            url: typeof input === 'string' ? input : input.url,
        });
        return respond(calls.length);
    };
    return calls;
}

function postTranslate({ accept, body, env = ENV, headers: extra = {} }) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (accept) headers.Accept = accept;
    const request = new Request('https://worker.test/translate', {
        body: JSON.stringify(body),
        headers,
        method: 'POST',
    });
    return worker.fetch(request, env, {});
}

function parseEvents(text) {
    const events = [];
    for (const block of text.split('\n\n')) {
        let name = null;
        let data = null;
        for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) name = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (name && data !== null) events.push({ data: JSON.parse(data), name });
    }
    return events;
}

/** Collects the generator's events so assertions can look at both phases. */
async function collect(lines, env = ENV, context = { name: 'song', artist: 'artist' }) {
    const events = [];
    for await (const event of streamTranslation(lines, env, context, {})) events.push(event);
    return events;
}

describe('incremental JSON scanner', () => {
    const EXPECTED = ['第一句', '第二句', 'with "quotes"', 'tab\tand\\backslash', '末尾'];

    function fullPayload() {
        return JSON.stringify({ translations: EXPECTED });
    }

    it('emits the same lines however the payload is split', () => {
        const payload = fullPayload();
        for (let cut = 0; cut <= payload.length; cut += 1) {
            const emitted = [];
            const scanner = createLineScanner((index, text) => emitted.push([index, text]));
            scanner.push(payload.slice(0, cut));
            scanner.push(payload.slice(cut));
            scanner.end();
            assert.deepEqual(
                emitted,
                EXPECTED.map((text, index) => [index, text]),
                `split at ${cut}`,
            );
            assert.deepEqual(scanner.result(), EXPECTED, `result at ${cut}`);
        }
    });

    it('emits the same lines when fed one character at a time', () => {
        const emitted = [];
        const scanner = createLineScanner((index, text) => emitted.push([index, text]));
        for (const char of fullPayload()) scanner.push(char);
        scanner.end();
        assert.deepEqual(emitted, EXPECTED.map((text, index) => [index, text]));
    });

    it('handles unicode escapes and a code fence', () => {
        const emitted = [];
        const scanner = createLineScanner((index, text) => emitted.push([index, text]));
        scanner.push('```json\n{"translations":["\\u4f60\\u597d","ok"]}\n```');
        scanner.end();
        assert.deepEqual(emitted, [
            [0, '你好'],
            [1, 'ok'],
        ]);
        assert.deepEqual(scanner.result(), ['你好', 'ok']);
    });

    it('keeps a truncated array as preview only', () => {
        const emitted = [];
        const scanner = createLineScanner((index, text) => emitted.push([index, text]));
        scanner.push('{"translations":["a","b","c');
        scanner.end();
        assert.deepEqual(emitted, [
            [0, 'a'],
            [1, 'b'],
        ]);
        assert.equal(scanner.result(), null);
    });

    it('ignores non-string elements without losing alignment', () => {
        const emitted = [];
        const scanner = createLineScanner((index, text) => emitted.push([index, text]));
        scanner.push('{"translations":["a",null,"c"]}');
        scanner.end();
        assert.deepEqual(emitted, [
            [0, 'a'],
            [2, 'c'],
        ]);
    });
});

describe('translate stream', () => {
    it('yields each line as soon as it is complete, then the full result', async () => {
        mockUpstream(() => translationStream(['甲', '乙', '丙']));
        const events = await collect(['one', 'two', 'three'], ENV, { name: 'stream-happy' });
        assert.deepEqual(events.filter((event) => event.type === 'line'), [
            { index: 0, text: '甲', type: 'line' },
            { index: 1, text: '乙', type: 'line' },
            { index: 2, text: '丙', type: 'line' },
        ]);
        assert.deepEqual(events.at(-1), { lines: ['甲', '乙', '丙'], type: 'done' });
    });

    it('asks upstream for a stream but not for a different prompt', async () => {
        const calls = mockUpstream(() => translationStream(['甲']));
        await collect(['one'], ENV, { artist: 'someone', name: 'stream-request' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body.stream, true);
        assert.equal(calls[0].body.model, ENV.LYRICS_AI_MODEL);
        assert.equal(calls[0].body.messages.length, 2);
        assert.match(calls[0].body.messages[1].content, /"lines":\["one"\]/);
    });

    it('accepts providers that ignore stream and answer with JSON', async () => {
        mockUpstream(() => new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ translations: ['甲', '乙'] }) } }],
        }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
        const events = await collect(['one', 'two'], ENV, { name: 'non-stream-provider' });
        assert.deepEqual(events.at(-1), { lines: ['甲', '乙'], type: 'done' });
    });

    it('falls back to the original lines for a truncated reply instead of dropping the song', async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(deltaEvent('{"translations":["甲","乙"')));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            },
        });
        mockUpstream(() => new Response(body, {
            headers: { 'Content-Type': 'text/event-stream' },
            status: 200,
        }));
        const events = await collect([' one ', 'two', 'three', 'four'], ENV, { name: 'truncated' });
        assert.deepEqual(events.at(-1), { lines: ['甲', '乙', 'three', 'four'], type: 'done' });
    });

    it('keeps one bad line as the original instead of failing the whole song', async () => {
        mockUpstream(() => translationStream(['甲', ' \n ', '丙']));
        const events = await collect(['one', 'two', 'three'], ENV, { name: 'one-bad-line' });
        assert.deepEqual(events.at(-1), { lines: ['甲', 'two', '丙'], type: 'done' });
    });

    it('degrades to the original lines when upstream fails', async () => {
        mockUpstream(() => new Response('nope', { status: 500 }));
        const events = await collect(['one', 'two'], ENV, { name: 'upstream-500' });
        assert.deepEqual(events.at(-1), { lines: ['one', 'two'], type: 'done' });
    });

    it('does not cache a partial result', async () => {
        const calls = mockUpstream(() => new Response('nope', { status: 500 }));
        await collect(['only'], ENV, { name: 'no-cache-on-failure' });
        await collect(['only'], ENV, { name: 'no-cache-on-failure' });
        assert.equal(calls.length, 2);
    });

    it('replays a cached translation without calling upstream again', async () => {
        const calls = mockUpstream(() => translationStream(['甲']));
        await collect(['cached line'], ENV, { name: 'cache-hit' });
        const events = await collect(['cached line'], ENV, { name: 'cache-hit' });
        assert.equal(calls.length, 1);
        assert.deepEqual(events.at(-1), { lines: ['甲'], type: 'done' });
    });

    it('reports null when translation is not configured', async () => {
        const events = await collect(['one'], {});
        assert.deepEqual(events, [{ lines: null, type: 'done' }]);
    });
});

describe('translate route', () => {
    const LINES = ['first line', 'second line'];

    it('streams server-sent events when the caller accepts them', async () => {
        mockUpstream(() => translationStream(['甲', '乙']));
        const response = await postTranslate({
            accept: 'text/event-stream',
            body: { lines: LINES, name: 'route-sse' },
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-accel-buffering'), 'no');

        const text = await response.text();
        assert.ok(text.startsWith(': open\n\n'), 'writes an immediate byte');
        const events = parseEvents(text);
        assert.deepEqual(events, [
            { data: { i: 0, t: '甲' }, name: 'line' },
            { data: { i: 1, t: '乙' }, name: 'line' },
            { data: { lines: ['甲', '乙'] }, name: 'done' },
        ]);
    });

    it('keeps the buffered JSON contract for existing bundles', async () => {
        mockUpstream(() => translationStream(['甲', '乙']));
        const response = await postTranslate({ body: { lines: LINES, name: 'route-json' } });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.deepEqual(await response.json(), { lines: ['甲', '乙'] });
    });

    it('survives a multibyte character split across network chunks', async () => {
        const encoder = new TextEncoder();
        const payload = `${deltaEvent('{"translations":["你好","世界"]}')}data: [DONE]\n\n`;
        const bytes = encoder.encode(payload);
        const cut = bytes.indexOf(0xe4) + 1;
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(bytes.slice(0, cut));
                controller.enqueue(bytes.slice(cut));
                controller.close();
            },
        });
        mockUpstream(() => new Response(body, {
            headers: { 'Content-Type': 'text/event-stream' },
            status: 200,
        }));
        const response = await postTranslate({
            accept: 'text/event-stream',
            body: { lines: LINES, name: 'route-multibyte' },
        });
        const events = parseEvents(await response.text());
        assert.deepEqual(events.at(-1), { data: { lines: ['你好', '世界'] }, name: 'done' });
    });

    it('rejects an oversized or malformed body', async () => {
        const response = await postTranslate({ body: { lines: [] } });
        assert.equal(response.status, 400);
    });

    it('reports a disabled feature as JSON even for streaming callers', async () => {
        const response = await postTranslate({
            accept: 'text/event-stream',
            body: { lines: LINES, name: 'route-disabled' },
            env: {},
        });
        assert.deepEqual(await response.json(), { lines: null });
    });
});

describe('request limits', () => {
    const LIMITS = { lineChars: 400, lines: 150, totalChars: 10000 };

    function post(body, ip = '203.0.113.7') {
        return postTranslate({ body, env: ENV, headers: { 'x-forwarded-for': ip } });
    }

    it('rejects a request with too many lines', async () => {
        const response = await post({ lines: Array.from({ length: LIMITS.lines + 1 }, () => 'x') });
        assert.equal(response.status, 400);
    });

    it('rejects a single over long line', async () => {
        const response = await post({ lines: ['y'.repeat(LIMITS.lineChars + 1)] });
        assert.equal(response.status, 400);
    });

    it('rejects a payload that is too long in total', async () => {
        const line = 'z'.repeat(100);
        const response = await post({ lines: Array.from({ length: 101 }, () => line) });
        assert.equal(response.status, 400);
    });

    it('accepts a full song sized payload', async () => {
        mockUpstream(() => translationStream(['甲']));
        const lines = Array.from({ length: 80 }, () => '夜が明けるまで歌う');
        const response = await post({ lines }, '198.51.100.9');
        assert.equal(response.status, 200);
    });

    it('rate limits one client once its window is used up', async () => {
        mockUpstream(() => translationStream(['甲']));
        const statuses = [];
        for (let i = 0; i < 16; i += 1) {
            const response = await post({ lines: ['one'], name: `limit-${i}` }, '192.0.2.44');
            statuses.push(response.status);
            if (response.status === 429) {
                assert.ok(Number(response.headers.get('retry-after')) >= 1);
                await response.body?.cancel();
            } else {
                await response.text();
            }
        }
        assert.equal(statuses.filter((status) => status === 200).length, 15);
        assert.equal(statuses.at(-1), 429);
    });

    it('caps how many translations run at once', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        globalThis.fetch = async () => {
            await gate;
            return translationStream(['甲']);
        };

        const requests = [0, 1, 2, 3].map((index) =>
            post({ lines: ['one'], name: `conc-${index}` }, '192.0.2.77'),
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        release();
        const responses = await Promise.all(requests);
        const statuses = responses.map((response) => response.status);
        assert.equal(statuses.filter((status) => status === 503).length, 2);
        assert.equal(statuses.filter((status) => status === 200).length, 2);
    });

    it('gives a new client its own budget', async () => {
        mockUpstream(() => translationStream(['甲']));
        for (let i = 0; i < 15; i += 1) {
            const response = await post({ lines: ['one'], name: `budget-a-${i}` }, '192.0.2.55');
            await response.text();
        }
        const other = await post({ lines: ['one'], name: 'budget-b' }, '192.0.2.56');
        assert.equal(other.status, 200);
        await other.text();
    });
});

describe('translation tag', () => {
    async function healthOf(env) {
        const response = await worker.fetch(new Request('https://worker.test/health'), env, {});
        return response.json();
    }

    it('exposes a stable tag that changes with the model', async () => {
        const first = await healthOf(ENV);
        assert.match(first.translationTag, /^[0-9a-f]{12}$/);
        assert.equal((await healthOf(ENV)).translationTag, first.translationTag);

        const other = await healthOf({ ...ENV, LYRICS_AI_MODEL: 'another-model' });
        assert.notEqual(other.translationTag, first.translationTag);
        assert.equal(other.aiTranslation, true);
    });

    it('changes with the target language', async () => {
        const english = await healthOf({ ...ENV, LYRICS_AI_TARGET_LANGUAGE: 'English' });
        assert.notEqual(english.translationTag, (await healthOf(ENV)).translationTag);
    });

    it('is absent when translation is off', async () => {
        const body = await healthOf({});
        assert.equal(body.translationTag, null);
        assert.equal(body.aiTranslation, false);
    });
});
