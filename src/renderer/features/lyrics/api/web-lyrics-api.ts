import isElectron from 'is-electron';

import { useSettingsStore } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import {
    InternetProviderLyricResponse,
    InternetProviderLyricSearchResponse,
    LyricGetQuery,
    LyricSearchQuery,
    LyricSource,
    QueueSong,
    Song,
} from '/@/shared/types/domain-types';
import {
    compareLyricCandidates,
    inspectLyricCandidates,
    LYRIC_MATCH_THRESHOLD,
    searchLyricCandidates,
} from '/@/shared/utils/lyrics-matching';

/**
 * Browser side remote lyrics lookups for the web build.
 *
 * The Electron build resolves internet lyrics inside its main process
 * (src/main/features/core/lyrics) and exposes three IPC calls to the renderer.
 * A web build has no main process, so this module implements the same three
 * calls in the renderer:
 *
 *   searchRemoteLyrics()        -> grouped candidates per provider
 *   getRemoteLyricsByRemoteId() -> lyrics for one candidate
 *   getRemoteLyricsBySong()     -> best match for the current song
 *
 * lyrics-api.ts selects this implementation when `isElectron()` is false, so
 * the automatic lookup on the player page and the manual search panel both work
 * in a browser without any further changes.
 *
 * Two transports are used per source:
 *   - direct: lrclib.net and api-lyrics.simpmusic.org answer with
 *     `Access-Control-Allow-Origin: *`, so a browser can call them directly.
 *   - proxy: NetEase and Genius require a Referer/User-Agent a browser is not
 *     allowed to set (and Genius blocks most datacenter traffic), so they are
 *     served by the lyrics proxy in lyrics-proxy/. It can either run inside the
 *     same deployment at /api/lyrics (auto-detected, used by the Vercel and
 *     EdgeOne Pages setups) or somewhere else, in which case its URL is
 *     configured in Settings -> Lyrics or through FS_LYRICS_PROXY_URL.
 *
 * A configured proxy is preferred for every source because it sends proper
 * User-Agent headers and caches responses at the edge; direct access remains as
 * a fallback if the proxy request fails.
 */

const REQUEST_TIMEOUT_MS = 8000;

/** Sources whose own API is reachable from a browser. */
const DIRECT_SOURCES: LyricSource[] = [LyricSource.LRCLIB, LyricSource.SIMPMUSIC];

type DirectEndpoints = {
    get: (id: string) => string;
    parseGet: (payload: unknown) => null | string;
    parseSearch: (payload: unknown) => RawHit[];
    search: (query: NormalizedQuery) => string;
};

type NormalizedQuery = {
    album?: string;
    artist: string;
    duration?: number;
    name: string;
};

type RawHit = {
    artist: string;
    duration?: number;
    id: string;
    isSync: boolean | null;
    name: string;
};

type WebProvider = {
    /** Endpoints used when the browser can talk to the provider itself. */
    direct?: DirectEndpoints;
    /** Path segment used by the lyrics proxy (lyrics-proxy/). */
    slug: string;
    source: LyricSource;
};

const asRecord = (value: unknown): null | Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

function buildUrl(
    base: string,
    params: Record<string, boolean | number | string | undefined>,
): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        search.set(key, String(value));
    }
    const query = search.toString();
    return query ? `${base}?${query}` : base;
}

function parseLrclibGet(payload: unknown): null | string {
    const song = asRecord(payload);
    if (!song) return null;
    return asString(song.syncedLyrics) || asString(song.plainLyrics) || null;
}

function parseLrclibSearch(payload: unknown): RawHit[] {
    if (!Array.isArray(payload)) return [];

    const hits: RawHit[] = [];
    for (const entry of payload) {
        const song = asRecord(entry);
        if (!song || song.id === null || song.id === undefined) continue;

        hits.push({
            artist: asString(song.artistName),
            duration: typeof song.duration === 'number' ? song.duration : undefined,
            id: String(song.id),
            isSync: Boolean(song.syncedLyrics),
            name: asString(song.name) || asString(song.trackName),
        });
    }

    return hits;
}

function parseProxyGet(payload: unknown): null | string {
    const lyrics = asRecord(payload)?.lyrics;
    return typeof lyrics === 'string' && lyrics.length > 0 ? lyrics : null;
}

/**
 * Envelope returned by every feishin-lyrics-worker endpoint:
 * `{ results: [{ artist, id, isSync, name }] }` or `{ lyrics: string | null }`.
 */
function parseProxySearch(payload: unknown): RawHit[] {
    const results = asRecord(payload)?.results;
    if (!Array.isArray(results)) return [];

    const hits: RawHit[] = [];
    for (const entry of results) {
        const hit = asRecord(entry);
        if (!hit || hit.id === null || hit.id === undefined) continue;

        hits.push({
            artist: asString(hit.artist),
            duration: typeof hit.duration === 'number' ? hit.duration : undefined,
            id: String(hit.id),
            isSync: hit.isSync === true ? true : hit.isSync === false ? false : null,
            name: asString(hit.name),
        });
    }

    return hits;
}

function parseSimpMusicGet(payload: unknown): null | string {
    const record = asRecord(payload);
    const first = Array.isArray(record?.data) ? asRecord(record?.data[0]) : record?.data;
    const song = asRecord(first);
    if (!song) return null;
    return asString(song.syncedLyrics) || asString(song.plainLyric) || null;
}

function parseSimpMusicSearch(payload: unknown): RawHit[] {
    const songs = asRecord(payload)?.data;
    if (!Array.isArray(songs)) return [];

    const hits: RawHit[] = [];
    for (const entry of songs) {
        const song = asRecord(entry);
        if (!song || !song.videoId) continue;

        hits.push({
            artist: asString(song.artistName),
            duration: typeof song.duration === 'number' ? song.duration : undefined,
            id: String(song.videoId),
            isSync: Boolean(song.syncedLyrics),
            name: asString(song.songTitle),
        });
    }

    return hits;
}

const PROVIDERS: Record<LyricSource, WebProvider> = {
    [LyricSource.GENIUS]: {
        // Genius needs a token-free but Referer-less HTML scrape and blocks most
        // datacenter traffic, so it is proxy only.
        slug: 'genius',
        source: LyricSource.GENIUS,
    },
    [LyricSource.LRCLIB]: {
        direct: {
            get: (id) => `https://lrclib.net/api/get/${encodeURIComponent(id)}`,
            parseGet: parseLrclibGet,
            parseSearch: parseLrclibSearch,
            search: (query) =>
                buildUrl('https://lrclib.net/api/search', {
                    q: [query.name, query.artist].filter(Boolean).join(' '),
                }),
        },
        slug: 'lrclib',
        source: LyricSource.LRCLIB,
    },
    [LyricSource.NETEASE]: {
        // music.163.com sends no CORS headers at all, so the browser cannot
        // reach it without the worker.
        slug: 'netease',
        source: LyricSource.NETEASE,
    },
    [LyricSource.SIMPMUSIC]: {
        direct: {
            get: (id) => `https://api-lyrics.simpmusic.org/v1/${encodeURIComponent(id)}`,
            parseGet: parseSimpMusicGet,
            parseSearch: parseSimpMusicSearch,
            // Upstream searches SimpMusic with the track name only.
            search: (query) =>
                buildUrl('https://api-lyrics.simpmusic.org/v1/search', { q: query.name }),
        },
        slug: 'simpmusic',
        source: LyricSource.SIMPMUSIC,
    },
};

/**
 * Same shape as window.api.lyrics.getRemoteLyricsByRemoteId in the Electron
 * build: the raw LRC (or plain text) for a single remote id.
 */
export async function getRemoteLyricsByRemoteId(params: LyricGetQuery): Promise<null | string> {
    const provider = PROVIDERS[params.remoteSource];
    if (!provider) return null;

    return getProviderLyrics(provider, params.remoteSongId);
}

/**
 * Same shape as window.api.lyrics.getRemoteLyricsBySong in the Electron build:
 * search every enabled provider, rank the merged candidates with the same
 * threshold the main process uses (0.55), then compare their lyric content.
 */
export async function getRemoteLyricsBySong(
    song: QueueSong | Song,
): Promise<InternetProviderLyricResponse | null> {
    const sources = enabledSources();
    const params = toSearchQuery(song);
    if (sources.length === 0 || (!params.name && !params.artist)) return null;

    const results = Object.values(await searchRemoteLyrics(params)).flat();
    const bestMatch = results
        .sort(compareLyricCandidates)
        .find((hit) => (hit.score ?? 1) <= LYRIC_MATCH_THRESHOLD && (hit.lyricsQuality ?? 0) > 0);
    if (!bestMatch?.lyrics) return null;

    return {
        artist: bestMatch.artist,
        id: bestMatch.id,
        lyrics:
            bestMatch.source !== LyricSource.NETEASE || getLyricsSettings().enableNeteaseTranslation
                ? bestMatch.lyrics
                : bestMatch.lyrics.replace(/_BREAK_[^\n]*/g, ''),
        name: bestMatch.name,
        source: bestMatch.source,
    };
}

/**
 * Base URL of the lyrics proxy. Empty when the deployment is unconfigured, in
 * which case only the CORS friendly sources are used.
 *
 * Resolution order: the (persisted, UI editable) setting first, then the
 * FS_LYRICS_PROXY_URL value injected by settings.js in the Docker image. A
 * relative value such as `/api/lyrics` is resolved against the current origin,
 * which is how this fork serves the proxy from the same deployment on Vercel
 * and EdgeOne Pages.
 */
export function getWebLyricsProxyUrl(): string {
    const configured = getLyricsSettings().proxyUrl ?? '';
    const injected = typeof window === 'undefined' ? '' : (window.FS_LYRICS_PROXY_URL ?? '');
    return normalizeProxyUrl(configured || injected || '');
}

function normalizeProxyUrl(raw: string): string {
    const value = (raw ?? '').trim();
    if (!value) return '';

    // Absolute URL: usable as is, no browser context required.
    if (/^https?:\/\//i.test(value)) {
        try {
            return new URL(value).toString().replace(/\/+$/, '');
        } catch {
            return '';
        }
    }

    // Relative path such as /api/lyrics: only meaningful inside a document.
    if (!value.startsWith('/') || typeof window === 'undefined') return '';

    try {
        const parsed = new URL(value, window.location.origin);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
}

/** Path where this repo serves the lyrics proxy from its own origin. */
export const SAME_ORIGIN_PROXY_PATH = '/api/lyrics';

let sameOriginProxy: null | Promise<string> = null;

/**
 * Detects a proxy served by the web app itself (see lyrics-proxy/). Deploying
 * the fork on Vercel or EdgeOne Pages exposes it at /api/lyrics, so no URL has
 * to be configured. Probed once per session and only when nothing is
 * configured.
 */
export function detectSameOriginProxy(): Promise<string> {
    // Outside a document (or in the desktop build) there is nothing to probe,
    // and that answer must not be cached: the caller may simply not have
    // loaded the app yet.
    if (isElectron() || typeof window === 'undefined') return Promise.resolve('');

    if (!sameOriginProxy) {
        sameOriginProxy = (async () => {
            const candidate = `${window.location.origin}${SAME_ORIGIN_PROXY_PATH}`;

            try {
                const health = asRecord(await fetchJson(`${candidate}/health`));
                if (health?.ok === true && health?.service === 'feishin-lyrics-worker') {
                    logger.info('Using same-origin lyrics proxy', { url: candidate });
                    return candidate;
                }
            } catch (error) {
                logger.debug('No same-origin lyrics proxy available', { error });
            }

            return '';
        })();
    }

    return sameOriginProxy;
}

/**
 * True when the web build has at least one usable remote source: a configured
 * proxy, or a source that speaks CORS. A same-origin proxy is detected
 * asynchronously and cannot be part of this synchronous UI check, which is why
 * the default provider selection (NetEase + lrclib.net) still shows the search
 * UI before the first lookup.
 */
export function isWebRemoteLyricsAvailable(sources?: LyricSource[]): boolean {
    if (isElectron()) return false;
    if (getWebLyricsProxyUrl()) return true;

    const enabled = sources ?? getLyricsSettings().sources ?? [];
    return enabled.some((source) => DIRECT_SOURCES.includes(source));
}

/**
 * Same shape as window.api.lyrics.searchRemoteLyrics in the Electron build.
 */
export async function searchRemoteLyrics(
    params: LyricSearchQuery,
): Promise<Record<LyricSource, InternetProviderLyricSearchResponse[]>> {
    const grouped = emptySearchResults();
    const sources = enabledSources();
    if (sources.length === 0 || (!params.name && !params.artist)) return grouped;

    const query: NormalizedQuery = {
        album: params.album,
        artist: params.artist ?? '',
        duration: params.duration,
        name: params.name ?? '',
    };

    const settled = await Promise.allSettled(
        sources.map((source) =>
            searchLyricCandidates(query, async (searchQuery) => {
                const hits = await searchProvider(PROVIDERS[source], {
                    ...searchQuery,
                    artist: searchQuery.artist ?? '',
                    name: searchQuery.name ?? '',
                });
                return hits.map((hit) => ({ ...hit, source }));
            }),
        ),
    );
    const candidates = settled.flatMap((result) =>
        result.status === 'fulfilled' ? result.value : [],
    );
    const inspected = await inspectLyricCandidates(
        candidates.sort((a, b) => (a.score ?? 1) - (b.score ?? 1)),
        (hit) => getProviderLyrics(PROVIDERS[hit.source], hit.id, true),
    );
    for (const hit of inspected) grouped[hit.source].push(hit);

    return grouped;
}

function emptySearchResults(): Record<LyricSource, InternetProviderLyricSearchResponse[]> {
    return {
        [LyricSource.GENIUS]: [],
        [LyricSource.LRCLIB]: [],
        [LyricSource.NETEASE]: [],
        [LyricSource.SIMPMUSIC]: [],
    };
}

function enabledSources(): LyricSource[] {
    const sources = getLyricsSettings().sources ?? [];
    return sources.filter((source) => source && PROVIDERS[source]);
}

async function fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(
                `${response.status} ${response.statusText} from ${new URL(url).origin}`,
            );
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function getLyricsSettings() {
    return useSettingsStore.getState().lyrics;
}

const providerLyricsCache = new Map<string, { expires: number; value: Promise<null | string> }>();

export async function resolveProxyUrl(): Promise<string> {
    return getWebLyricsProxyUrl() || (await detectSameOriginProxy());
}

async function fetchProviderLyrics(
    provider: WebProvider,
    id: string,
    includeTranslation: boolean,
): Promise<null | string> {
    const proxyUrl = await resolveProxyUrl();
    const translate = provider.source === LyricSource.NETEASE && includeTranslation;

    if (proxyUrl) {
        try {
            const lyrics = await proxyGet(provider, id, translate, proxyUrl);
            if (lyrics) return lyrics;
        } catch (error) {
            if (!provider.direct) {
                logger.warn('Lyrics proxy lookup failed', { error, source: provider.source });
                return null;
            }

            logger.warn('Lyrics proxy lookup failed, falling back to the provider API', {
                error,
                source: provider.source,
            });
        }
    }

    if (!provider.direct) return null;

    try {
        return provider.direct.parseGet(await fetchJson(provider.direct.get(id)));
    } catch (error) {
        logger.warn('Direct lyrics lookup failed', { error, source: provider.source });
        return null;
    }
}

async function getProviderLyrics(
    provider: WebProvider,
    id: string,
    includeTranslation = Boolean(getLyricsSettings().enableNeteaseTranslation),
): Promise<null | string> {
    const key = JSON.stringify([getWebLyricsProxyUrl(), provider.source, id, includeTranslation]);
    const cached = providerLyricsCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (providerLyricsCache.size >= 50) {
        const oldest = providerLyricsCache.keys().next().value;
        if (oldest) providerLyricsCache.delete(oldest);
    }
    const value = fetchProviderLyrics(provider, id, includeTranslation).then((lyrics) => {
        if (!lyrics) providerLyricsCache.delete(key);
        return lyrics;
    });
    providerLyricsCache.set(key, { expires: Date.now() + 300000, value });
    return value;
}

async function proxyGet(
    provider: WebProvider,
    id: string,
    translate: boolean,
    proxyUrl: string,
): Promise<null | string> {
    const url = buildUrl(`${proxyUrl}/get`, {
        id,
        source: provider.slug,
        translate: translate ? 1 : undefined,
    });

    return parseProxyGet(await fetchJson(url));
}

async function proxySearch(
    provider: WebProvider,
    query: NormalizedQuery,
    proxyUrl: string,
): Promise<RawHit[]> {
    const url = buildUrl(`${proxyUrl}/search`, {
        album: query.album,
        artist: query.artist,
        duration: query.duration,
        name: query.name,
        source: provider.slug,
    });

    return parseProxySearch(await fetchJson(url));
}

async function searchProvider(provider: WebProvider, query: NormalizedQuery): Promise<RawHit[]> {
    const proxyUrl = await resolveProxyUrl();

    if (proxyUrl) {
        try {
            return await proxySearch(provider, query, proxyUrl);
        } catch (error) {
            if (!provider.direct) {
                logger.warn('Lyrics proxy search failed', { error, source: provider.source });
                return [];
            }

            logger.warn('Lyrics proxy search failed, falling back to the provider API', {
                error,
                source: provider.source,
            });
        }
    }

    if (!provider.direct) return [];

    try {
        return provider.direct.parseSearch(await fetchJson(provider.direct.search(query)));
    } catch (error) {
        logger.warn('Direct lyrics search failed', { error, source: provider.source });
        return [];
    }
}

function toSearchQuery(song: QueueSong | Song): NormalizedQuery {
    const artist = song.artists?.map((artist) => artist.name).join(', ') || song.artistName || '';

    return {
        album: song.album || song.name,
        artist,
        duration: typeof song.duration === 'number' ? song.duration / 1000 : undefined,
        name: song.name,
    };
}

/**
 * Drop-in replacement for `window.api.lyrics` in the web build. Only the three
 * remote lookup methods are implemented; the conversion helpers used by
 * use-furigana-lyrics keep coming from the web build's own alias
 * (`/@/lyrics-conversion-api`).
 */
export const webLyricsApi = {
    getRemoteLyricsByRemoteId,
    getRemoteLyricsBySong,
    searchRemoteLyrics,
};
