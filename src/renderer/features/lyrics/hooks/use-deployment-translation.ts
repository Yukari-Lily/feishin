import type { LyricsResponse } from '/@/shared/types/domain-types';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { queryKeys } from '/@/renderer/api/query-keys';
import {
    getWebLyricsProxyUrl,
    resolveProxyUrl,
} from '/@/renderer/features/lyrics/api/web-lyrics-api';
import { logger } from '/@/renderer/utils/logger';
import { getLyricsQuality, lyricContentLines } from '/@/shared/utils/lyrics-matching';

/** Where the deployment's lyrics proxy lives and which model it currently uses. */
type ProxyInfo = {
    /** Changes whenever the model, target language or prompt version changes. */
    tag: null | string;
    url: string;
};

type TranslationContext = {
    artist?: string;
    hasExistingTranslation?: boolean;
    name?: string;
};

type TranslationEvent = {
    data: Record<string, unknown>;
    name: string;
};

/** A translated line; `undefined` until the model has written it. */
type TranslationLine = string | undefined;

/**
 * Lines can arrive one at a time. `complete` is false while the stream is still
 * running, so a half filled array is never treated as a finished translation.
 */
type TranslationResult = {
    complete: boolean;
    lines: TranslationLine[];
};

/** Coalesce cache writes so a fast stream does not re-render per line. */
const PARTIAL_WRITE_INTERVAL_MS = 100;
/** The worker stops stalled upstream calls itself; this only bounds a dead connection. */
const REQUEST_TIMEOUT_MS = 180000;
const SHORT_STALE_MS = 15000;
const SUCCESS_STALE_MS = 86400000;
/** Must match the worker's caps, otherwise the request is rejected with 400. */
const MAX_LINES = 150;
const MAX_LINE_CHARS = 400;
const MAX_TOTAL_CHARS = 10000;

/** Set when the worker answers 429, so a burst of skips does not keep hammering it. */
let nextAllowedAt = 0;

export function useDeploymentTranslation(
    lyrics: LyricsResponse | null | undefined,
    context: TranslationContext = {},
    enabled = true,
) {
    const queryClient = useQueryClient();
    const lines = useMemo(
        () =>
            Array.isArray(lyrics) ? lyrics.map((line) => line.text) : (lyrics ?? '').split('\n'),
        [lyrics],
    );
    const text = lines.join('\n');
    const canTranslate =
        enabled &&
        !context.hasExistingTranslation &&
        !text.includes('_BREAK_') &&
        getLyricsQuality(text) > 0;
    const { data: proxyInfo } = useQuery<null | ProxyInfo>({
        enabled: canTranslate,
        queryFn: async () => {
            const url = await resolveProxyUrl();
            if (!url) return null;
            try {
                const response = await fetch(`${url}/health`, {
                    signal: AbortSignal.timeout(8000),
                });
                const health = response.ok ? await response.json() : null;
                if (health?.aiTranslation !== true) return null;
                return {
                    tag: typeof health.translationTag === 'string' ? health.translationTag : null,
                    url,
                };
            } catch (error) {
                logger.debug('Deployment translation unavailable', { error });
                return null;
            }
        },
        queryKey: queryKeys.songs.lyricsTranslationHealth(getWebLyricsProxyUrl()),
        retry: false,
        staleTime: 60000,
    });
    const proxy = proxyInfo?.url ?? null;
    const translationTag = proxyInfo?.tag ?? null;
    const content = useMemo(
        () => lines.filter((line) => lyricContentLines(line).length > 0),
        [lines],
    );
    const translationContext = useMemo(
        () => ({ artist: context.artist, name: context.name }),
        [context.artist, context.name],
    );
    const translationQueryKey = useMemo(
        () =>
            queryKeys.songs.lyricsTranslation(
                proxy ?? '',
                content,
                translationContext,
                translationTag,
            ),
        [content, proxy, translationContext, translationTag],
    );
    const { data, isFetching } = useQuery<null | TranslationResult>({
        enabled:
            canTranslate &&
            !!proxy &&
            content.length <= MAX_LINES &&
            content.every((line) => line.length <= MAX_LINE_CHARS) &&
            content.join('').length <= MAX_TOTAL_CHARS,
        gcTime: SUCCESS_STALE_MS,
        queryFn: async ({ client, queryKey, signal }) => {
            if (Date.now() < nextAllowedAt) return null;
            try {
                const response = await fetch(`${proxy}/translate`, {
                    body: JSON.stringify({
                        artist: translationContext.artist,
                        lines: content,
                        name: translationContext.name,
                    }),
                    headers: {
                        Accept: 'text/event-stream',
                        'Content-Type': 'application/json',
                    },
                    method: 'POST',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
                });
                if (response.status === 429) {
                    const retryAfter = Number(response.headers.get('retry-after')) || 30;
                    nextAllowedAt = Date.now() + retryAfter * 1000;
                    return null;
                }
                if (!response.ok) throw new Error(`Translation returned ${response.status}`);
                return await readTranslation(response, content, (partial) =>
                    client.setQueryData<null | TranslationResult>(queryKey, {
                        complete: false,
                        lines: partial,
                    }),
                );
            } catch (error) {
                if (!signal.aborted) logger.warn('Automatic lyrics translation failed', { error });
                return null;
            }
        },
        queryKey: translationQueryKey,
        retry: false,
        staleTime: (query) => (query.state.data?.complete ? SUCCESS_STALE_MS : SHORT_STALE_MS),
    });

    useEffect(() => {
        if (canTranslate) return;
        void queryClient.cancelQueries({ exact: true, queryKey: translationQueryKey });
    }, [canTranslate, queryClient, translationQueryKey]);

    // Leaving a song must release its stream, otherwise the worker keeps a
    // concurrency slot busy and the next song gets throttled.
    useEffect(() => {
        const key = translationQueryKey;
        return () => {
            void queryClient.cancelQueries({ exact: true, queryKey: key });
        };
    }, [queryClient, translationQueryKey]);

    if (!canTranslate || !proxy || !data) {
        return { isTranslating: canTranslate && !!proxy && isFetching, translation: null };
    }
    let index = 0;
    return {
        isTranslating: isFetching,
        translation: lines
            .map((line) => {
                if (!lyricContentLines(line).length) return '';
                const translated = data.lines[index++];
                return translated === line.trim() ? '' : translated;
            })
            .join('\n'),
    };
}

/**
 * Validates the worker's reply. Lines that cannot be shown are dropped instead
 * of failing the song, and a reply with nothing translated is treated as a
 * failure so the short stale time lets it be retried later.
 */
function acceptLines(value: unknown, content: string[]): null | TranslationLine[] {
    if (value === null) return null;
    if (!Array.isArray(value) || value.length !== content.length) return null;

    const lines = value.map((line) => {
        if (typeof line !== 'string') return undefined;
        const translated = line.trim();
        if (!translated || translated.length > 2000 || /[\r\n]|_BREAK_/.test(translated)) {
            return undefined;
        }
        return translated;
    });

    const translated = lines.some((line, index) => line != null && line !== content[index].trim());
    return translated ? lines : null;
}

function parseTranslationEvent(block: string): null | TranslationEvent {
    let name = '';
    const data: string[] = [];
    for (const rawLine of block.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).trimStart();
        if (field === 'event') name = value.trim();
        else if (field === 'data') data.push(value);
    }
    if (!name || data.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(data.join('\n'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return { data: parsed as Record<string, unknown>, name };
    } catch {
        return null;
    }
}

/**
 * Reads the translation reply, reporting lines as they arrive.
 *
 * The worker answers with server-sent events when `Accept: text/event-stream`
 * is sent and with the older single JSON body otherwise, so both shapes are
 * accepted. The final `done` event stays authoritative: a stream that ends
 * early only costs the lines that never arrived.
 */
async function readTranslation(
    response: Response,
    content: string[],
    onPartial: (lines: TranslationLine[]) => void,
): Promise<null | TranslationResult> {
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream') || !response.body) {
        const payload: unknown = await response.json();
        const lines = acceptLines((payload as null | { lines?: unknown })?.lines, content);
        return lines ? { complete: true, lines } : null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const partial: TranslationLine[] = [];
    let buffer = '';
    let lastWrite = 0;
    let result: null | TranslationResult = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const event = parseTranslationEvent(buffer.slice(0, boundary));
                buffer = buffer.slice(boundary + 2);
                if (!event) continue;

                if (event.name === 'line') {
                    const lineIndex = event.data.i;
                    const lineText = event.data.t;
                    if (typeof lineIndex === 'number' && typeof lineText === 'string') {
                        partial[lineIndex] = lineText;
                    }
                    const now = Date.now();
                    if (now - lastWrite >= PARTIAL_WRITE_INTERVAL_MS) {
                        lastWrite = now;
                        onPartial([...partial]);
                    }
                } else if (event.name === 'done') {
                    const lines = acceptLines(event.data.lines, content);
                    result = lines ? { complete: true, lines } : null;
                }
            }
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // The reader is already released.
        }
    }

    return result;
}
