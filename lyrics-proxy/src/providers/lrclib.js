/**
 * LRCLib - https://lrclib.net
 *
 * Credits to https://github.com/tranxuanthang/lrcget for the API usage; the
 * query shape below mirrors Feishin's own Electron provider
 * (src/main/features/core/lyrics/lrclib.ts) so web and desktop rank the same
 * candidate list.
 *
 * LRCLib sends permissive CORS headers, so the browser could call it
 * directly. Requests still go through the worker when one is configured
 * because LRCLib asks clients to identify themselves with a descriptive
 * User-Agent, which browsers are not allowed to set.
 */

import { baseUrl, fetchJson, timeoutMs } from '../lib/http.js';

const DEFAULT_BASE = 'https://lrclib.net';
const USER_AGENT = 'feishin-lyrics-worker/1.0 (https://github.com/jeffvli/feishin)';

export async function search(params, env) {
    const { artist, name } = params;
    if (!name && !artist) return [];

    const base = baseUrl(env, 'LRCLIB_BASE_URL', DEFAULT_BASE);
    const query = [name, artist].filter(Boolean).join(' ');
    const url = `${base}/api/search?${new URLSearchParams({ q: query })}`;

    const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } }, timeoutMs(env));
    if (!Array.isArray(data)) return [];

    return data
        .filter((song) => song && song.id != null)
        .map((song) => ({
            artist: song.artistName ?? '',
            id: String(song.id),
            isSync: Boolean(song.syncedLyrics),
            name: song.name ?? song.trackName ?? '',
        }));
}

export async function get(id, env) {
    if (!id) return null;

    const base = baseUrl(env, 'LRCLIB_BASE_URL', DEFAULT_BASE);
    const url = `${base}/api/get/${encodeURIComponent(id)}`;

    const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } }, timeoutMs(env));
    return data?.syncedLyrics || data?.plainLyrics || null;
}
