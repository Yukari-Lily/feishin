import clsx from 'clsx';
import { ReactElement, useLayoutEffect, useRef, useState } from 'react';
import { generatePath, Link } from 'react-router';

import imageColumnStyles from '../item-detail-list/columns/image-column.module.css';
import { AlbumGroupControls } from './album-group-controls';
import styles from './album-group-header.module.css';
import { TableItemSize } from './item-table-list';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { JoinedArtists } from '/@/renderer/features/albums/components/joined-artists';
import { PlayButton } from '/@/renderer/features/shared/components/play-button';
import {
    LONG_PRESS_PLAY_BEHAVIOR,
    PlayTooltip,
} from '/@/renderer/features/shared/components/play-button-group';
import { AppRoute } from '/@/renderer/router/routes';
import { useAlbumGroupImageSize, usePlayButtonBehavior } from '/@/renderer/store';
import { LibraryItem, Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

interface AlbumGroupHeaderProps {
    groupRowCount?: number;
    onPlay?: (playType: Play) => void;
    rowIndex?: number;
    setAlbumGroupContentHeight?: (rowIndex: number, height: number) => void;
    size?: 'compact' | 'large' | 'normal';
    song: Song | undefined;
}

export const AlbumGroupHeader = ({
    groupRowCount,
    onPlay,
    rowIndex,
    setAlbumGroupContentHeight,
    size = 'normal',
    song,
}: AlbumGroupHeaderProps): ReactElement => {
    const [isHovered, setIsHovered] = useState(false);
    const [resolvedInfoHeight, setResolvedInfoHeight] = useState<number | undefined>();
    const playButtonBehavior = usePlayButtonBehavior();
    const albumImageSize = useAlbumGroupImageSize();
    const rowHeight = {
        compact: TableItemSize.COMPACT,
        large: TableItemSize.LARGE,
        normal: TableItemSize.DEFAULT,
    }[size];

    const albumPath = song?.albumId
        ? generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId: song.albumId })
        : null;

    // The album group spans the combined row height, but when the image is
    // enlarged the group's last row is grown so the total reaches the img size.
    const infoHeight =
        groupRowCount !== undefined
            ? albumImageSize > 0
                ? Math.max(albumImageSize, groupRowCount * rowHeight)
                : groupRowCount * rowHeight
            : undefined;

    const imageContainerStyle =
        albumImageSize > 0
            ? {
                  aspectRatio: 'auto',
                  height: `${albumImageSize}px`,
                  paddingBottom: 'var(--theme-spacing-xs)',
                  paddingTop: 'var(--theme-spacing-xs)',
                  position: 'relative' as const,
                  width: `${albumImageSize}px`,
                  zIndex: 1,
              }
            : undefined;

    const infoRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const infoEl = infoRef.current;
        if (!infoEl) return;

        const measure = () => {
            const contentHeight = infoEl.scrollHeight;
            const resolved = Math.max(infoHeight ?? 0, contentHeight);

            setResolvedInfoHeight(resolved);

            if (rowIndex !== undefined && setAlbumGroupContentHeight) {
                setAlbumGroupContentHeight(rowIndex, contentHeight);
            }
        };

        measure();

        const resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(infoEl);

        return () => resizeObserver.disconnect();
    }, [infoHeight, rowIndex, setAlbumGroupContentHeight]);

    return (
        <div
            className={styles.container}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div className={styles.imageContainer} style={imageContainerStyle}>
                <ItemImage
                    className={imageColumnStyles.compactImage}
                    enableDebounce
                    enableViewport={false}
                    id={song?.imageId}
                    itemType={LibraryItem.SONG}
                    src={song?.imageUrl}
                    type="table"
                />
                {isHovered && onPlay && (
                    <div className={imageColumnStyles.playButtonOverlay}>
                        <PlayTooltip type={playButtonBehavior}>
                            <PlayButton
                                fill
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onPlay(playButtonBehavior);
                                }}
                                onLongPress={(e) => {
                                    e.stopPropagation();
                                    onPlay(LONG_PRESS_PLAY_BEHAVIOR[playButtonBehavior]);
                                }}
                            />
                        </PlayTooltip>
                    </div>
                )}
            </div>
            <div
                className={clsx(styles.info, albumImageSize > 0 && styles.enlargedImage)}
                ref={infoRef}
                style={{ minHeight: resolvedInfoHeight ?? infoHeight }}
            >
                <div className={styles.albumName}>
                    {song?.albumId && albumPath ? (
                        <Link state={{ item: song }} to={albumPath}>
                            {song.album ?? ''}
                        </Link>
                    ) : (
                        (song?.album ?? '')
                    )}
                </div>
                <div className={styles.artistName}>
                    <JoinedArtists
                        artistName={song?.albumArtistName ?? ''}
                        artists={song?.albumArtists ?? []}
                        linkProps={{ fw: 400 }}
                        rootTextProps={{ fw: 400, size: 'xs' }}
                    />
                </div>
                <div className={styles.controlsRow}>
                    <AlbumGroupControls
                        albumId={song?.albumId}
                        isGroupHovered={isHovered}
                        serverId={song?._serverId}
                        serverType={song?._serverType}
                    />
                </div>
            </div>
        </div>
    );
};
