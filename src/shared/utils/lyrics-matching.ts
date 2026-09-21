import type { LyricSearchQuery } from '/@/shared/types/domain-types';

import Fuse from 'fuse.js';

export const LYRIC_MATCH_THRESHOLD = 0.55;

type LyricCandidate = {
    artist: string;
    duration?: number;
    id: string;
    isSync: boolean | null;
    lyrics?: null | string;
    lyricsQuality?: number;
    name: string;
    score?: number;
    source: string;
};

const normalize = (value: string) =>
    value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{Z}\p{S}]/gu, '');

// Character (CV: performer) tags name the performer, not a different artist.
export function normalizeLyricArtist(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/[^,;/、・·()]+\(\s*cv\s*[:.]\s*([^()]+)\)/gi, '$1')
        .replace(/([^()]+)\(([^()]+)\)/g, (_match: string, group: string, members: string) =>
            /[,;/、・·]/.test(members) ? members : `${group}, ${members}`,
        )
        .replace(/\s*(?:[,&;/、・·]|\bfeat\.?|\bft\.?)\s*/gi, ', ')
        .trim();
}

function artistAliases(value: string): string[] {
    const clean = normalizeLyricArtist(value);
    const members = clean.split(',').map(normalize).filter(Boolean).sort();
    const group = value.normalize('NFKC').match(/^([^()]+)\(/)?.[1];
    return [...new Set([members.join(''), ...(group ? [normalize(group)] : [])])];
}

function matchScore(query: string[], values: string[]): number {
    if (query.some((item) => values.includes(item))) return 0;
    const fuse = new Fuse(values, { ignoreLocation: true, includeScore: true, threshold: 0.6 });
    return Math.min(1, ...query.flatMap((item) => fuse.search(item).map((hit) => hit.score ?? 1)));
}

const version = (name: string) =>
    name
        .normalize('NFKC')
        .toLowerCase()
        .match(
            /\b(?:inst(?:rumental)?|off\s*vocal|karaoke|live|remix|cover|acoustic|tv\s*size)\b|伴奏|纯音乐/,
        )?.[0] ?? '';

export function compareLyricCandidates<T extends LyricCandidate>(a: T, b: T): number {
    const eligible = (item: InternetProviderLyricSearchResponse) =>
        (item.score ?? 1) <= LYRIC_MATCH_THRESHOLD ? 1 : 0;
    return (
        eligible(b) - eligible(a) ||
        (b.lyricsQuality ?? -1) - (a.lyricsQuality ?? -1) ||
        (a.score ?? 1) - (b.score ?? 1) ||
        Number(b.isSync === true) - Number(a.isSync === true)
    );
}

export function getLyricsQuality(lyrics: null | string | undefined): number {
    if (!lyrics) return 0;
    const lines = lyricContentLines(lyrics);
    // ponytail: body length is a heuristic; providers do not certify completeness.
    if (lines.length < 3) return 0;
    const translated = lines.filter((line) => {
        const [original, translation] = line.split('_BREAK_');
        return translation?.trim() && normalize(original) !== normalize(translation);
    }).length;
    return translated >= lines.length / 2 ? 2 : 1;
}

export async function inspectLyricCandidates<T extends LyricCandidate>(
    results: T[],
    get: (hit: T) => Promise<null | string>,
): Promise<T[]> {
    // ponytail: inspect at most five plausible matches per search to bound provider traffic.
    const candidates = results
        .filter((hit) => (hit.score ?? 1) <= LYRIC_MATCH_THRESHOLD)
        .slice(0, 5);
    const inspected = await Promise.all(
        candidates.map(async (hit) => {
            const lyrics = await get(hit);
            return {
                ...hit,
                isSync: lyrics ? /\[\d+:\d+/.test(lyrics) : hit.isSync,
                lyrics,
                lyricsQuality: getLyricsQuality(lyrics),
            } as T;
        }),
    );
    const longest = Math.max(
        0,
        ...inspected.map((hit) => lyricContentLines(hit.lyrics ?? '').length),
    );
    const byId = new Map(
        inspected.map((hit) => {
            // A fragment should not beat a full version just because it has a translation.
            if (lyricContentLines(hit.lyrics ?? '').length < longest / 2) hit.lyricsQuality = 0;
            return [`${hit.source}:${hit.id}`, hit];
        }),
    );
    return results
        .map((hit) => byId.get(`${hit.source}:${hit.id}`) ?? hit)
        .sort(compareLyricCandidates);
}

export function lyricContentLines(lyrics: string): string[] {
    return lyrics
        .split('\n')
        .map((line) =>
            line
                .trim()
                .replace(/^(?:\[[^\]]*\])+/, '')
                .replace(/\(\d+,\d+\)/g, '')
                .trim(),
        )
        .filter(
            (line) =>
                line &&
                !/^(?:(?:作词|作曲|编曲|編曲|作詞|词|曲|詞|翻译|翻譯|制作|製作|演唱|歌手|监制|混音|录音|母带|出品|发行|版权|lyrics?|composer|arranger|producer|vocal|written\s+by)\s*[:：]|纯音乐|純音樂|此歌曲为没有填词的纯音乐|暂无歌词|暫無歌詞|no lyrics|instrumental\s*$)/i.test(
                    line,
                ),
        );
}

export function orderSearchResults<T extends LyricCandidate>({
    params,
    results,
}: {
    params: LyricSearchQuery;
    results: T[];
}): T[] {
    return results
        .map((item) => {
            const titleScore = params.name
                ? matchScore([normalize(params.name)], [normalize(item.name)])
                : 0;
            const artistScore = params.artist
                ? matchScore(artistAliases(params.artist), artistAliases(item.artist))
                : 0;
            const wrongVersion = params.name && version(params.name) !== version(item.name);
            const wrongDuration =
                params.duration &&
                item.duration &&
                Math.abs(params.duration - item.duration) > Math.max(12, params.duration * 0.1);
            return {
                ...item,
                score: Math.max(titleScore, artistScore, wrongVersion || wrongDuration ? 1 : 0),
            };
        })
        .sort(compareLyricCandidates);
}

export async function searchLyricCandidates<T extends LyricCandidate>(
    params: LyricSearchQuery,
    search: (query: LyricSearchQuery) => Promise<T[]>,
): Promise<T[]> {
    const results = await search({ ...params, artist: normalizeLyricArtist(params.artist ?? '') });
    let ranked = orderSearchResults({ params, results });
    if (
        params.name &&
        params.artist &&
        !ranked.some((hit) => (hit.score ?? 1) <= LYRIC_MATCH_THRESHOLD)
    ) {
        const fallback = await search({ ...params, artist: '' });
        const fallbackRanked = orderSearchResults({
            params: { ...params, artist: '' },
            results: fallback,
        });
        const unique = new Map(ranked.map((hit) => [`${hit.source}:${hit.id}`, hit]));
        for (const hit of fallbackRanked) {
            const key = `${hit.source}:${hit.id}`;
            const current = unique.get(key);
            if (!current || compareLyricCandidates(hit, current) < 0) unique.set(key, hit);
        }
        ranked = [...unique.values()].sort(compareLyricCandidates);
    }
    return ranked;
}
