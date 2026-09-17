/**
 * Minimal HTML helpers used by the Genius provider.
 *
 * Upstream Feishin parses the Genius song page with cheerio inside the
 * Electron main process. Workers have no DOM, and pulling cheerio into a
 * worker bundle is unnecessary weight for what is a linear scan over a single
 * page, so this module implements the same three rules by hand:
 *
 *   1. a legacy `<div class="lyrics">` block wins if it exists,
 *   2. otherwise every `<div data-lyrics-container="true">` is collected,
 *   3. nodes marked `data-exclude-from-selection="true"` are dropped,
 *   4. `<br>` becomes a newline and the remaining markup is stripped.
 *
 * It is intentionally dependency free so it can be unit tested in Node.
 */

const VOID_BREAKS = /<br\s*\/?>/gi;

export function decodeEntities(input) {
    if (!input.includes('&')) return input;

    return input
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
        .replace(/&(nbsp|amp|quot|lt|gt|apos|#39);/gi, (_, name) => {
            switch (name.toLowerCase()) {
                case 'nbsp':
                    return ' ';
                case 'amp':
                    return '&';
                case 'quot':
                    return '"';
                case 'lt':
                    return '<';
                case 'gt':
                    return '>';
                default:
                    return "'";
            }
        });
}

function safeCodePoint(code) {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    try {
        return String.fromCodePoint(code);
    } catch {
        return '';
    }
}

export function stripTags(fragment) {
    return decodeEntities(
        fragment
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(VOID_BREAKS, '\n')
            .replace(/<[^>]*>/g, ''),
    );
}

export function cleanLyrics(text) {
    if (!text) return null;
    const cleaned = text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return cleaned.length > 0 ? cleaned : null;
}

/**
 * Returns the inner HTML of the element that owns the first opening tag
 * matched by `openTagRegex`, using depth counting so nested elements of the
 * same tag name do not terminate the slice early.
 */
export function sliceElement(html, openTagRegex, tagName = 'div', fromIndex = 0) {
    openTagRegex.lastIndex = fromIndex;
    const match = openTagRegex.exec(html);
    if (!match) return null;

    const start = match.index + match[0].length;
    const openRe = new RegExp(`<${tagName}\\b`, 'gi');
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');

    let depth = 1;
    let cursor = start;

    while (depth > 0) {
        openRe.lastIndex = cursor;
        closeRe.lastIndex = cursor;
        const nextOpen = openRe.exec(html);
        const nextClose = closeRe.exec(html);

        if (!nextClose) return html.slice(start);

        if (nextOpen && nextOpen.index < nextClose.index) {
            depth += 1;
            cursor = nextOpen.index + nextOpen[0].length;
            continue;
        }

        depth -= 1;
        if (depth === 0) return html.slice(start, nextClose.index);
        cursor = nextClose.index + nextClose[0].length;
    }

    return null;
}

/**
 * Removes every element carrying `data-exclude-from-selection="true"`,
 * including anything nested inside it.
 */
export function removeExcludedNodes(fragment) {
    const openRe = /<(span|div|p|a|sup|section)\b[^>]*data-exclude-from-selection="true"[^>]*>/gi;
    let result = fragment;
    let guard = 0;
    let match;

    while ((match = openRe.exec(result)) !== null && guard < 200) {
        guard += 1;
        const tagName = match[1];
        const inner = sliceElement(result, openRe, tagName, match.index);
        if (inner === null) break;

        const innerEnd = match.index + match[0].length + inner.length;
        const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
        const closeMatch = closeRe.exec(result.slice(innerEnd));
        const end = closeMatch ? innerEnd + closeMatch.index + closeMatch[0].length : innerEnd;

        result = result.slice(0, match.index) + result.slice(end);
        openRe.lastIndex = 0;
    }

    return result;
}

/**
 * Extracts plain text lyrics from a Genius song page.
 *
 * @param {string} html raw HTML of a genius.com song page
 * @returns {string|null}
 */
export function extractGeniusLyrics(html) {
    if (typeof html !== 'string' || html.length === 0) return null;

    const legacy = sliceElement(html, /<div[^>]*class="[^"]*\blyrics\b[^"]*"[^>]*>/i);
    if (legacy) {
        const text = cleanLyrics(stripTags(legacy));
        if (text) return text;
    }

    const containerRe = /<div[^>]*data-lyrics-container="true"[^>]*>/gi;
    const sections = [];
    let match;
    while ((match = containerRe.exec(html)) !== null) {
        const inner = sliceElement(html, containerRe, 'div', match.index);
        if (inner) sections.push(stripTags(removeExcludedNodes(inner)));
        containerRe.lastIndex = match.index + match[0].length;
    }

    return cleanLyrics(sections.join('\n'));
}
