import axios, { AxiosResponse } from 'axios';

import {
    InternetProviderLyricResponse,
    InternetProviderLyricSearchResponse,
    LyricSearchQuery,
    LyricSource,
} from '.';
import { store } from '../settings';
import { orderSearchResults } from './shared';

import log from '/@/main/logger';

const SEARCH_URL = 'https://music.163.com/api/search/get';
const LYRICS_URL = 'https://music.163.com/api/song/lyric';

// Adapted from https://github.com/NyaomiDEV/Sunamu/blob/master/src/main/lyricproviders/netease.ts

export interface Result {
    hasMore: boolean;
    songCount: number;
    songs: Song[];
}

interface Album {
    artist: Artist;
    copyrightId: number;
    id: number;
    mark: number;
    name: string;
    picId: number;
    publishTime: number;
    size: number;
    status: number;
    transNames?: string[];
}

interface Artist {
    albumSize: number;
    alias: any[];
    fansGroup: null;
    id: number;
    img1v1: number;
    img1v1Url: string;
    name: string;
    picId: number;
    picUrl: null;
    trans: null;
}

interface NetEaseResponse {
    code: number;
    result: Result;
}

interface Song {
    album: Album;
    alias: string[];
    artists: Artist[];
    copyrightId: number;
    duration: number;
    fee: number;
    ftype: number;
    id: number;
    mark: number;
    mvid: number;
    name: string;
    rtype: number;
    rUrl: null;
    status: number;
    transNames?: string[];
}

export async function getLyricsBySongId(
    songId: string,
    enableTranslation = store.get('enableNeteaseTranslation', true) as boolean,
): Promise<null | string> {
    let result: AxiosResponse<any, any>;
    try {
        result = await axios.get(LYRICS_URL, {
            params: {
                id: songId,
                kv: '-1',
                lv: '-1',
                tv: '-1',
            },
            timeout: 8000,
        });
    } catch (e) {
        log.error('NetEase lyrics request got an error!', e);
        return null;
    }
    const originalLrc = result.data.lrc?.lyric;
    if (!enableTranslation) {
        return originalLrc || null;
    }
    const translatedLrc = result.data.tlyric?.lyric;
    return mergeLyrics(originalLrc, translatedLrc);
}

export async function getSearchResults(
    params: LyricSearchQuery,
): Promise<InternetProviderLyricSearchResponse[] | null> {
    let result: AxiosResponse<NetEaseResponse>;

    const searchQuery = [params.artist, params.name].join(' ');

    if (!searchQuery) {
        return null;
    }

    try {
        result = await axios.get(SEARCH_URL, {
            params: {
                limit: 5,
                offset: 0,
                s: searchQuery,
                type: '1',
            },
            timeout: 8000,
        });
    } catch (e) {
        log.error('NetEase search request got an error!', e);
        return null;
    }

    const rawSongsResult = result?.data.result?.songs;

    if (!rawSongsResult) return null;

    const songResults: InternetProviderLyricSearchResponse[] = rawSongsResult.map((song) => {
        const artist = song.artists ? song.artists.map((artist) => artist.name).join(', ') : '';

        return {
            artist,
            duration: song.duration / 1000,
            id: String(song.id),
            isSync: null,
            name: song.name,
            source: LyricSource.NETEASE,
        };
    });

    return orderSearchResults({ params, results: songResults });
}

export async function query(
    params: LyricSearchQuery,
): Promise<InternetProviderLyricResponse | null> {
    const lyricsMatch = await getMatchedLyrics(params);
    if (!lyricsMatch) {
        return null;
    }

    const lyrics = await getLyricsBySongId(lyricsMatch.id);
    if (!lyrics) {
        return null;
    }

    return {
        artist: lyricsMatch.artist,
        id: lyricsMatch.id,
        lyrics,
        name: lyricsMatch.name,
        source: LyricSource.NETEASE,
    };
}

async function getMatchedLyrics(
    params: LyricSearchQuery,
): Promise<null | Omit<InternetProviderLyricResponse, 'lyrics'>> {
    const results = await getSearchResults(params);

    const firstMatch = results?.[0];

    if (!firstMatch || (firstMatch?.score && firstMatch.score > 0.5)) {
        return null;
    }

    return firstMatch;
}

function mergeLyrics(original: string | undefined, translated: string | undefined): null | string {
    if (!original) {
        return null;
    }
    if (!translated) {
        return original;
    }

    const lrcLineRegex = /\[(\d{1,}:\d{2}(?:\.\d{1,3})?)\](.*)/;
    const timestampMs = (timestamp: string) => {
        const [minutes, seconds] = timestamp.split(':');
        return Math.round((Number(minutes) * 60 + Number(seconds)) * 1000);
    };
    const translatedMap = new Map<number, string>();
    for (const line of translated.split('\n')) {
        const match = line.match(lrcLineRegex);
        if (match?.[2].trim()) translatedMap.set(timestampMs(match[1]), match[2].trim());
    }
    return original
        .split('\n')
        .map((line) => {
            const match = line.match(lrcLineRegex);
            if (!match) return line;
            const translatedText = translatedMap.get(timestampMs(match[1]));
            const originalText = match[2].trim();
            if (!translatedText || !originalText || translatedText === originalText) return line;
            return `[${match[1]}]${originalText}_BREAK_${translatedText}`;
        })
        .join('\n');
}
