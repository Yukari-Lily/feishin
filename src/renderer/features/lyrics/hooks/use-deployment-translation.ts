import type { LyricsResponse } from '/@/shared/types/domain-types';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryKeys } from '/@/renderer/api/query-keys';
import {
    getWebLyricsProxyUrl,
    resolveProxyUrl,
} from '/@/renderer/features/lyrics/api/web-lyrics-api';
import { logger } from '/@/renderer/utils/logger';
import { getLyricsQuality, lyricContentLines } from '/@/shared/utils/lyrics-matching';

export function useDeploymentTranslation(
    lyrics: LyricsResponse | null | undefined,
    enabled = true,
) {
    const lines = useMemo(
        () =>
            Array.isArray(lyrics) ? lyrics.map((line) => line.text) : (lyrics ?? '').split('\n'),
        [lyrics],
    );
    const text = lines.join('\n');
    const canTranslate = enabled && !text.includes('_BREAK_') && getLyricsQuality(text) > 0;
    const { data: proxy } = useQuery({
        enabled: canTranslate,
        queryFn: async () => {
            const url = await resolveProxyUrl();
            if (!url) return null;
            try {
                const response = await fetch(`${url}/health`, {
                    signal: AbortSignal.timeout(8000),
                });
                const health = response.ok ? await response.json() : null;
                return health?.aiTranslation === true ? url : null;
            } catch (error) {
                logger.debug('Deployment translation unavailable', { error });
                return null;
            }
        },
        queryKey: queryKeys.songs.lyricsTranslation(getWebLyricsProxyUrl()),
        retry: false,
        staleTime: 60000,
    });
    const content = useMemo(
        () => lines.filter((line) => lyricContentLines(line).length > 0),
        [lines],
    );
    const { data } = useQuery({
        enabled:
            canTranslate &&
            !!proxy &&
            content.length <= 300 &&
            content.every((line) => line.length <= 1000) &&
            content.join('').length <= 20000,
        gcTime: 86400000,
        queryFn: async ({ signal }) => {
            try {
                const response = await fetch(`${proxy}/translate`, {
                    body: JSON.stringify({ lines: content }),
                    headers: { 'Content-Type': 'application/json' },
                    method: 'POST',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
                });
                if (!response.ok) throw new Error(`Translation returned ${response.status}`);
                const result = await response.json();
                const translated: unknown = result?.lines;
                if (translated === null) return null;
                if (
                    !Array.isArray(translated) ||
                    translated.length !== content.length ||
                    translated.some(
                        (line) =>
                            typeof line !== 'string' ||
                            !line.trim() ||
                            line.length > 2000 ||
                            /[\r\n]|_BREAK_/.test(line),
                    )
                ) {
                    throw new Error('Translation line count or format mismatch');
                }
                return translated as string[];
            } catch (error) {
                if (!signal.aborted) logger.warn('Automatic lyrics translation failed', { error });
                return null;
            }
        },
        queryKey: queryKeys.songs.lyricsTranslation(proxy ?? '', content),
        retry: false,
        staleTime: (query) => (query.state.data === null ? 60000 : 86400000),
    });
    if (!canTranslate || !proxy || !data) return null;
    let index = 0;
    return lines
        .map((line) => {
            if (!lyricContentLines(line).length) return '';
            const translated = data[index++];
            return translated === line.trim() ? '' : translated;
        })
        .join('\n');
}
