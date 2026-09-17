/**
 * Genius
 *
 * Mirrors Feishin's Electron provider
 * (src/main/features/core/lyrics/genius.ts) against the public, token free
 * endpoints:
 *
 *   search : https://genius.com/api/search/song?q=...&per_page=5
 *   lyrics : the song URL returned by the search, scraped from
 *            div[data-lyrics-container="true"]
 *
 * Genius serves plain text only (no timestamps), so `isSync` is always null
 * and results act as a last resort next to LRCLib / NetEase / SimpMusic.
 *
 * Note: genius.com is fronted by Cloudflare and rejects a lot of datacenter
 * traffic with HTTP 403. When that happens this provider simply returns no
 * results and the other sources still work. Operators can drop "genius" from
 * ENABLED_SOURCES to stop asking.
 */

import { BROWSER_USER_AGENT, baseUrl, fetchJson, fetchWithTimeout, timeoutMs, UpstreamError } from '../lib/http.js';
import { extractGeniusLyrics } from '../lib/html.js';

const DEFAULT_BASE = 'https://genius.com';

export async function search(params, env) {
    const query = [params.artist, params.name].filter(Boolean).join(' ').trim();
    if (!query) return [];

    const base = baseUrl(env, 'GENIUS_BASE_URL', DEFAULT_BASE);
    const url = `${base}/api/search/song?${new URLSearchParams({ per_page: '5', q: query })}`;

    const data = await fetchJson(url, { headers: { 'User-Agent': BROWSER_USER_AGENT } }, timeoutMs(env));
    const hits = data?.response?.sections?.[0]?.hits ?? [];

    return hits
        .map((hit) => hit?.result)
        .filter((song) => song && song.url)
        .map((song) => ({
            artist: song.artist_names ?? '',
            id: song.url,
            isSync: null,
            name: song.full_title || song.title || '',
        }));
}

export async function get(id, env) {
    if (!id) return null;

    const url = resolveSongUrl(id, env);
    if (!url) return null;

    const res = await fetchWithTimeout(
        url,
        {
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': BROWSER_USER_AGENT,
            },
        },
        timeoutMs(env),
    );

    if (!res.ok) {
        throw new UpstreamError(`genius responded ${res.status} for the song page`, res.status);
    }

    const html = await res.text();
    return extractGeniusLyrics(html);
}

/**
 * Song ids are absolute genius.com URLs. Only URLs on the configured Genius
 * host are followed so the worker cannot be pointed at arbitrary hosts.
 */
export function resolveSongUrl(id, env) {
    let parsed;
    try {
        parsed = new URL(id);
    } catch {
        return null;
    }

    const base = new URL(baseUrl(env, 'GENIUS_BASE_URL', DEFAULT_BASE));
    if (parsed.protocol !== 'https:' || parsed.hostname !== base.hostname) return null;

    return parsed.toString();
}
