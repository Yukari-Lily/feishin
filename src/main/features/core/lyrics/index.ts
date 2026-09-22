import { ipcMain } from 'electron';

import { store } from '../settings';
import {
    convertFurigana,
    convertFuriganaFragment,
    convertRomaji,
    convertRomajiTokens,
    parseLyricsTextTokens,
} from './furigana';
import { getLyricsBySongId as getGenius, getSearchResults as searchGenius } from './genius';
import { getLyricsBySongId as getLrcLib, getSearchResults as searchLrcLib } from './lrclib';
import { getLyricsBySongId as getNetease, getSearchResults as searchNetease } from './netease';
import {
    getLyricsBySongId as getSimpMusic,
    getSearchResults as searchSimpMusic,
} from './simpmusic';

import log from '/@/main/logger';
import { Song } from '/@/shared/types/domain-types';
import {
    inspectLyricCandidates,
    LYRIC_MATCH_THRESHOLD,
    searchLyricCandidates,
} from '/@/shared/utils/lyrics-matching';

export enum LyricSource {
    GENIUS = 'Genius',
    LRCLIB = 'lrclib.net',
    NETEASE = 'NetEase',
    SIMPMUSIC = 'SimpMusic',
}

export type FullLyricsMetadata = Omit<InternetProviderLyricResponse, 'id' | 'lyrics' | 'source'> & {
    lyrics: LyricsResponse;
    remote: boolean;
    source: string;
};

export type InternetProviderLyricResponse = {
    artist: string;
    hasTranslation?: boolean;
    id: string;
    lyrics: string;
    name: string;
    source: LyricSource;
};

export type InternetProviderLyricSearchResponse = {
    artist: string;
    duration?: number;
    hasTranslation?: boolean;
    id: string;
    isSync: boolean | null;
    lyrics?: null | string;
    lyricsQuality?: number;
    name: string;
    score?: number;
    source: LyricSource;
};

export type LyricGetQuery = {
    remoteSongId: string;
    remoteSource: LyricSource;
    song: Song;
};

export type LyricOverride = Omit<InternetProviderLyricResponse, 'lyrics'>;

export type LyricSearchQuery = {
    album?: string;
    artist?: string;
    duration?: number;
    name?: string;
};

export type LyricsResponse = string | SynchronizedLyricsArray;

export type SynchronizedLyricsArray = Array<[number, string]>;

type CachedLyrics = Record<LyricSource, InternetProviderLyricResponse>;
type GetFetcher = (id: string) => Promise<null | string>;
type SearchFetcher = (
    params: LyricSearchQuery,
) => Promise<InternetProviderLyricSearchResponse[] | null>;

const SEARCH_FETCHERS: Record<LyricSource, SearchFetcher> = {
    [LyricSource.GENIUS]: searchGenius,
    [LyricSource.LRCLIB]: searchLrcLib,
    [LyricSource.NETEASE]: searchNetease,
    [LyricSource.SIMPMUSIC]: searchSimpMusic,
};

const GET_FETCHERS: Record<LyricSource, GetFetcher> = {
    [LyricSource.GENIUS]: getGenius,
    [LyricSource.LRCLIB]: getLrcLib,
    [LyricSource.NETEASE]: getNetease,
    [LyricSource.SIMPMUSIC]: getSimpMusic,
};

const MAX_CACHED_ITEMS = 10;

const lyricCache = new Map<string, CachedLyrics>();

const searchAllSources = async (
    params: LyricSearchQuery,
): Promise<InternetProviderLyricSearchResponse[]> => {
    const sources = store.get('lyrics', []) as LyricSource[];

    const searchPromises = sources.map((source) =>
        searchLyricCandidates(
            params,
            async (query) => (await SEARCH_FETCHERS[source](query)) ?? [],
        ).then((searchResults) => ({ searchResults, source })),
    );

    const settled = await Promise.allSettled(searchPromises);

    const allSearchResults: InternetProviderLyricSearchResponse[] = [];

    for (const result of settled) {
        if (result.status === 'fulfilled' && result.value.searchResults) {
            allSearchResults.push(...result.value.searchResults);
        } else if (result.status === 'rejected') {
            const index = settled.indexOf(result);
            log.error(`Error searching ${sources[index]} for lyrics:`, result.reason);
        }
    }
    return inspectLyricCandidates(
        allSearchResults.sort((a, b) => (a.score ?? 1) - (b.score ?? 1)),
        async (hit) => {
            try {
                return hit.source === LyricSource.NETEASE
                    ? await getNetease(hit.id, true)
                    : await GET_FETCHERS[hit.source](hit.id);
            } catch (error) {
                log.warn('Lyrics candidate lookup failed', { error, source: hit.source });
                return null;
            }
        },
    );
};

const getRemoteLyrics = async (song: Song) => {
    const sources = store.get('lyrics', []) as LyricSource[];

    const cacheKey = JSON.stringify([
        song._serverId,
        song.id,
        song.name,
        song.artists,
        sources,
        store.get('enableNeteaseTranslation', true),
    ]);
    const cached = lyricCache.get(cacheKey);

    if (cached) {
        for (const source of sources) {
            const data = cached[source];
            if (data) return data;
        }
    }

    const params: LyricSearchQuery = {
        album: song.album || song.name,
        artist: song.artists?.map((artist) => artist.name).join(', ') || song.artistName || '',
        duration: song.duration / 1000.0,
        name: song.name,
    };

    const allSearchResults = await searchAllSources(params);

    if (allSearchResults.length === 0) {
        return null;
    }

    const bestMatch = allSearchResults.find(
        (hit) => (hit.score ?? 1) <= LYRIC_MATCH_THRESHOLD && (hit.lyricsQuality ?? 0) > 0,
    );
    if (!bestMatch?.lyrics) return null;
    const lyricsFromSource: InternetProviderLyricResponse = {
        artist: bestMatch.artist,
        hasTranslation: bestMatch.hasTranslation,
        id: bestMatch.id,
        lyrics:
            bestMatch.source !== LyricSource.NETEASE || store.get('enableNeteaseTranslation', true)
                ? bestMatch.lyrics
                : bestMatch.lyrics.replace(/_BREAK_[^\n]*/g, ''),
        name: bestMatch.name,
        source: bestMatch.source,
    };

    if (lyricsFromSource) {
        const newResult = cached
            ? {
                  ...cached,
                  [lyricsFromSource.source]: lyricsFromSource,
              }
            : ({ [lyricsFromSource.source]: lyricsFromSource } as CachedLyrics);

        if (lyricCache.size === MAX_CACHED_ITEMS && cached === undefined) {
            const toRemove = lyricCache.keys().next().value;
            if (toRemove) {
                lyricCache.delete(toRemove);
            }
        }

        lyricCache.set(cacheKey, newResult);
    }

    return lyricsFromSource;
};

const searchRemoteLyrics = async (params: LyricSearchQuery) => {
    const allSearchResults = await searchAllSources(params);

    const results: Record<LyricSource, InternetProviderLyricSearchResponse[]> = {
        [LyricSource.GENIUS]: [],
        [LyricSource.LRCLIB]: [],
        [LyricSource.NETEASE]: [],
        [LyricSource.SIMPMUSIC]: [],
    };
    for (const item of allSearchResults) {
        results[item.source].push(item);
    }
    return results;
};

const getRemoteLyricsById = async (params: LyricGetQuery): Promise<null | string> => {
    const { remoteSongId, remoteSource } = params;
    const response =
        remoteSource === LyricSource.NETEASE
            ? await getNetease(remoteSongId, true)
            : await GET_FETCHERS[remoteSource](remoteSongId);

    if (!response) {
        return null;
    }

    return remoteSource === LyricSource.NETEASE && !store.get('enableNeteaseTranslation', true)
        ? response.replace(/_BREAK_[^\n]*/g, '')
        : response;
};

ipcMain.handle('lyric-by-song', async (_event, song: any) => {
    const lyric = await getRemoteLyrics(song);
    return lyric;
});

ipcMain.handle('lyric-search', async (_event, params: LyricSearchQuery) => {
    const lyricResults = await searchRemoteLyrics(params);
    return lyricResults;
});

ipcMain.handle('lyric-by-remote-id', async (_event, params: LyricGetQuery) => {
    const lyricResults = await getRemoteLyricsById(params);
    return lyricResults;
});

ipcMain.handle('lyric-convert-furigana', async (_event, text: string) => {
    return await convertFurigana(text);
});

ipcMain.handle('lyric-convert-furigana-fragment', async (_event, text: string) => {
    return await convertFuriganaFragment(text);
});

ipcMain.handle('lyric-parse-text-tokens', async (_event, text: string) => {
    return await parseLyricsTextTokens(text);
});

ipcMain.handle('lyric-convert-romaji', async (_event, text: string) => {
    return await convertRomaji(text);
});

ipcMain.handle('lyric-convert-romaji-tokens', async (_event, text: string) => {
    return await convertRomajiTokens(text);
});
