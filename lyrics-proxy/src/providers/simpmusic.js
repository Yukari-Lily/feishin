/**
 * SimpMusic - https://api-lyrics.simpmusic.org
 *
 * Mirrors Feishin's Electron provider
 * (src/main/features/core/lyrics/simpmusic.ts): search is performed with the
 * track name only, and the videoId of a result doubles as the lyric id.
 */

import { baseUrl, fetchJson, timeoutMs } from '../lib/http.js';

const DEFAULT_BASE = 'https://api-lyrics.simpmusic.org';

export async function search(params, env) {
    if (!params.name) return [];

    const base = baseUrl(env, 'SIMPMUSIC_BASE_URL', DEFAULT_BASE);
    const url = `${base}/v1/search?${new URLSearchParams({ q: params.name })}`;

    const data = await fetchJson(url, {}, timeoutMs(env));
    const songs = data?.data;
    if (!Array.isArray(songs)) return [];

    return songs
        .filter((song) => song && song.videoId)
        .map((song) => ({
            artist: song.artistName ?? '',
            id: String(song.videoId),
            isSync: Boolean(song.syncedLyrics),
            name: song.songTitle ?? '',
        }));
}

export async function get(id, env) {
    if (!id) return null;

    const base = baseUrl(env, 'SIMPMUSIC_BASE_URL', DEFAULT_BASE);
    const url = `${base}/v1/${encodeURIComponent(id)}`;

    const data = await fetchJson(url, {}, timeoutMs(env));
    const first = Array.isArray(data?.data) ? data.data[0] : data?.data;
    if (!first) return null;

    return first.syncedLyrics || first.plainLyric || null;
}
