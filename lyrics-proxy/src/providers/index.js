/**
 * Provider registry.
 *
 * `feishinSource` must match the `LyricSource` enum values used by Feishin
 * (src/shared/types/domain-types.ts) byte for byte, because the renderer uses
 * that string both as a display label and as the key of the grouped search
 * response.
 */

import * as genius from './genius.js';
import * as lrclib from './lrclib.js';
import * as netease from './netease.js';
import * as simpmusic from './simpmusic.js';

export const PROVIDERS = {
    genius: { ...genius, feishinSource: 'Genius' },
    lrclib: { ...lrclib, feishinSource: 'lrclib.net' },
    netease: { ...netease, feishinSource: 'NetEase' },
    simpmusic: { ...simpmusic, feishinSource: 'SimpMusic' },
};

export const PROVIDER_SLUGS = Object.keys(PROVIDERS).sort();

export const DEFAULT_ENABLED_SOURCES = PROVIDER_SLUGS;

/**
 * Reads the ENABLED_SOURCES var and intersects it with the known providers, so
 * a typo in the config can never produce a crash on the request path.
 */
export function resolveEnabledSources(env) {
    const raw = env?.ENABLED_SOURCES;
    if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_ENABLED_SOURCES;

    const requested = raw
        .split(',')
        .map((slug) => slug.trim().toLowerCase())
        .filter(Boolean);

    const enabled = PROVIDER_SLUGS.filter((slug) => requested.includes(slug));
    return enabled.length > 0 ? enabled : DEFAULT_ENABLED_SOURCES;
}
