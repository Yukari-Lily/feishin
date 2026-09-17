/**
 * NetEase Cloud Music (网易云音乐)
 *
 * Mirrors Feishin's Electron provider
 * (src/main/features/core/lyrics/netease.ts) with two deliberate additions:
 *
 *  1. The legacy `/api/search/get` endpoint now returns unrelated results for
 *     many queries when the caller is outside mainland China. The newer
 *     `/api/cloudsearch/pc` endpoint (plain form POST, no weapi/eapi
 *     encryption) still returns correct matches, so it is tried first and the
 *     legacy endpoint is kept as a fallback.
 *  2. Translation request handling lives here because only this side can see
 *     the `tlyric` payload.
 *
 * Both the search and lyric endpoints require a `Referer` header, which is
 * exactly why a browser cannot call them directly and a proxy is needed.
 */

import { BROWSER_USER_AGENT, baseUrl, fetchJson, fetchWithTimeout, timeoutMs, UpstreamError } from '../lib/http.js';

const DEFAULT_BASE = 'https://music.163.com';
const SEARCH_LIMIT = 5;

function neteaseHeaders(extra = {}) {
    return {
        Referer: 'https://music.163.com/',
        'User-Agent': BROWSER_USER_AGENT,
        ...extra,
    };
}

async function cloudSearch(base, query, env) {
    const url = `${base}/api/cloudsearch/pc`;
    const body = new URLSearchParams({
        limit: String(SEARCH_LIMIT),
        offset: '0',
        s: query,
        total: 'true',
        type: '1',
    }).toString();

    const data = await fetchJson(
        url,
        {
            body,
            headers: neteaseHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
            method: 'POST',
        },
        timeoutMs(env),
    );

    return data?.result?.songs ?? [];
}

async function legacySearch(base, query, env) {
    const params = new URLSearchParams({
        limit: String(SEARCH_LIMIT),
        offset: '0',
        s: query,
        type: '1',
    });

    const data = await fetchJson(
        `${base}/api/search/get?${params.toString()}`,
        { headers: neteaseHeaders() },
        timeoutMs(env),
    );

    return data?.result?.songs ?? [];
}

/** Normalizes the cloudsearch (`ar`/`al`/`dt`) and legacy (`artists`/`album`/`duration`) shapes. */
function normalizeSong(song) {
    if (!song || song.id == null) return null;

    const artists = song.ar ?? song.artists ?? [];
    const artist = Array.isArray(artists)
        ? artists
              .map((entry) => entry?.name)
              .filter(Boolean)
              .join(', ')
        : '';

    const album = song.al ?? song.album ?? null;

    return {
        album: album?.name ?? '',
        artist,
        duration: typeof song.dt === 'number' ? song.dt / 1000 : (song.duration ?? 0) / 1000,
        id: String(song.id),
        isSync: null,
        name: song.name ?? '',
    };
}

export async function search(params, env) {
    const query = [params.artist, params.name].filter(Boolean).join(' ').trim();
    if (!query) return [];

    const base = baseUrl(env, 'NETEASE_BASE_URL', DEFAULT_BASE);

    let songs = [];
    try {
        songs = await cloudSearch(base, query, env);
    } catch {
        songs = [];
    }

    if (songs.length === 0) {
        try {
            songs = await legacySearch(base, query, env);
        } catch {
            songs = [];
        }
    }

    return songs.map(normalizeSong).filter(Boolean);
}

export async function get(id, env, options = {}) {
    if (!id) return null;

    const base = baseUrl(env, 'NETEASE_BASE_URL', DEFAULT_BASE);
    const params = new URLSearchParams({ id: String(id), kv: '-1', lv: '-1', tv: '-1' });
    const url = `${base}/api/song/lyric?${params.toString()}`;

    const res = await fetchWithTimeout(url, { headers: neteaseHeaders() }, timeoutMs(env));
    if (!res.ok) {
        throw new UpstreamError(`upstream responded ${res.status} for song/lyric`, res.status);
    }

    const data = await res.json();
    const original = data?.lrc?.lyric || null;
    if (!original) return null;

    if (!options.translate) return original;

    return mergeLyrics(original, data?.tlyric?.lyric);
}

/**
 * Port of mergeLyrics() from Feishin's Electron provider. Translations are
 * appended to the matching timestamp and joined with the `_BREAK_` delimiter
 * the renderer expects.
 */
export function mergeLyrics(original, translated) {
    if (!original) return null;
    if (!translated) return original;

    const lrcLineRegex = /\[(\d{2}:\d{2}\.\d{2,3})\](.*)/;
    const translatedMap = new Map();

    for (const line of translated.split('\n')) {
        const match = line.match(lrcLineRegex);
        if (!match) continue;
        const text = match[2].trim();
        if (text) translatedMap.set(match[1], text);
    }

    if (translatedMap.size === 0) return original;

    return original
        .split('\n')
        .map((line) => {
            const match = line.match(lrcLineRegex);
            if (!match) return line;

            const [, timestamp, rawText] = match;
            const originalText = rawText.trim();
            const translatedText = translatedMap.get(timestamp);

            if (translatedText && originalText) {
                return [`[${timestamp}]${originalText}`, translatedText].join('_BREAK_');
            }

            return line;
        })
        .join('\n');
}
