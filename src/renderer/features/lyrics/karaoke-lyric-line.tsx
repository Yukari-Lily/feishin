import clsx from 'clsx';
import { ComponentPropsWithoutRef, memo, useMemo } from 'react';

import styles from './karaoke-lyric-line.module.css';

import { testRtl } from '/@/renderer/features/lyrics/api/lyrics-rtl';
import { splitWordCues } from '/@/renderer/features/lyrics/api/split-word-cue';
import { sanitize } from '/@/renderer/utils/sanitize';
import { Box } from '/@/shared/components/box/box';
import { Stack } from '/@/shared/components/stack/stack';
import { LyricAgent, SyncedCueLine } from '/@/shared/types/domain-types';

const LONG_WORD_THRESHOLD_MS = 1500;
const FURIGANA_HTML_RE = /<ruby[\s>]/i;

const hasFuriganaHtml = (text: string): boolean => FURIGANA_HTML_RE.test(text);

interface KaraokeLyricLineProps extends ComponentPropsWithoutRef<'div'> {
    agents?: LyricAgent[];
    alignment: 'center' | 'left' | 'right';
    cueLines: SyncedCueLine[];
    fontSize: number;
    lineIndex: number;
    romajiCueLines?: (null | SyncedCueLine)[] | null;
    romajiText?: null | string;
    text?: string;
    translatedText?: null | string;
}

type WordSpanVariant = 'main' | 'romaji';

const renderWordSpans = (
    cueLine: SyncedCueLine,
    lineIndex: number,
    cueLineIndex: number,
    isBackground: boolean,
    variant: WordSpanVariant = 'main',
) => {
    const isRomaji = variant === 'romaji';
    const idPrefix = isRomaji ? 'karaoke-romaji' : 'karaoke';

    if (!cueLine.words.length) {
        return (
            <span
                className={clsx(styles.karaokeWord, isRomaji && 'karaoke-romaji-word')}
                dangerouslySetInnerHTML={{ __html: sanitize(cueLine.value) }}
                data-lyric-time={cueLine.startMs}
            />
        );
    }

    const splitWords =
        isRomaji || cueLine.words.some((word) => hasFuriganaHtml(word.text))
            ? cueLine.words
            : splitWordCues(cueLine.words);
    let wordCounter = 0;

    return splitWords.map((word) => {
        const durationMs = word.endMs - word.startMs;
        const durationSec = durationMs / 1000;
        const timeSec = word.startMs / 1000;
        const isRtl = testRtl(word.text);
        const isZeroDuration = durationMs <= 0;
        const hasFurigana = !isRomaji && hasFuriganaHtml(word.text);
        const sanitizedHtml = sanitize(word.text);
        const currentWordIndex = wordCounter;
        wordCounter += 1;

        const wordClassName = clsx(
            styles.karaokeWord,
            'karaoke-word',
            isRomaji && 'karaoke-romaji-word',
            isRtl && 'karaoke-rtl',
            isBackground && 'karaoke-bg-vocal',
            isZeroDuration && 'karaoke-zero-dur',
            hasFurigana && 'karaoke-furigana-word',
        );

        const wordKey = `${word.startMs}-${currentWordIndex}`;
        const wordProps = {
            className: wordClassName,
            'data-duration': String(durationSec),
            'data-lyric-time': cueLine.startMs,
            'data-time': String(timeSec),
            'data-word-start': word.startMs,
            id: `${idPrefix}-${lineIndex}-cue-${cueLineIndex}-word-${currentWordIndex}`,
            style: {
                '--karaoke-duration': `${durationMs}ms`,
            } as React.CSSProperties,
            ...(durationMs > LONG_WORD_THRESHOLD_MS ? { 'data-long-word': true as const } : {}),
        };

        return (
            <span key={wordKey} {...wordProps}>
                <span
                    className="karaoke-word-text"
                    dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
                <span
                    aria-hidden
                    className="karaoke-word-highlight"
                    dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
            </span>
        );
    });
};

export const KaraokeLyricLine = memo(
    ({
        agents,
        alignment,
        className,
        cueLines,
        fontSize,
        lineIndex,
        romajiCueLines,
        romajiText,
        translatedText,
        ...props
    }: KaraokeLyricLineProps) => {
        const style = useMemo(
            () => ({
                fontSize,
                textAlign: alignment,
            }),
            [fontSize, alignment],
        );

        const hasSyncedRomaji = romajiCueLines != null;

        return (
            <Box
                className={clsx(styles.karaokeLine, 'karaoke-line', className)}
                style={style}
                {...props}
            >
                <Stack align="stretch" gap={0} w="100%">
                    {cueLines.map((cueLine, cueLineIndex) => {
                        const agent = agents?.find((entry) => entry.id === cueLine.agentId);
                        const isBackground = agent?.role === 'bg' || agent?.role === 'group';
                        const romajiCueLine = romajiCueLines?.[cueLineIndex];

                        return (
                            <div
                                className={styles.agentLine}
                                data-agent-role={agent?.role}
                                key={`${cueLine.index}-${cueLineIndex}`}
                            >
                                <span
                                    className={styles.agentText}
                                    id={
                                        cueLineIndex === 0
                                            ? `karaoke-anchor-${lineIndex}`
                                            : undefined
                                    }
                                >
                                    {renderWordSpans(
                                        cueLine,
                                        lineIndex,
                                        cueLineIndex,
                                        isBackground,
                                        'main',
                                    )}
                                </span>
                                {romajiCueLine && (
                                    <span className={styles.romajiLine}>
                                        {renderWordSpans(
                                            romajiCueLine,
                                            lineIndex,
                                            cueLineIndex,
                                            false,
                                            'romaji',
                                        )}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                    {!hasSyncedRomaji && romajiText && (
                        <span
                            className={styles.romajiLine}
                            dangerouslySetInnerHTML={{ __html: sanitize(romajiText) }}
                        />
                    )}
                    {translatedText && (
                        <span dangerouslySetInnerHTML={{ __html: sanitize(translatedText) }} />
                    )}
                </Stack>
            </Box>
        );
    },
);

KaraokeLyricLine.displayName = 'KaraokeLyricLine';
