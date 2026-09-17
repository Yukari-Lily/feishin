/**
 * Small fetch helpers shared by every provider.
 *
 * Everything in here must stay usable both inside workerd (the Cloudflare
 * runtime) and inside plain Node, because the test suite runs the very same
 * modules under `node --test`.
 */

export const DEFAULT_TIMEOUT_MS = 8000;

export class UpstreamError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'UpstreamError';
        this.status = status;
    }
}

export function timeoutMs(env) {
    const value = Number(env?.UPSTREAM_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

export async function fetchWithTimeout(url, init = {}, timeout = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchJson(url, init = {}, timeout = DEFAULT_TIMEOUT_MS) {
    const res = await fetchWithTimeout(url, init, timeout);
    if (!res.ok) {
        throw new UpstreamError(`${describe(res.status)} for ${shortUrl(url)}`, res.status);
    }
    return res.json();
}

export async function fetchText(url, init = {}, timeout = DEFAULT_TIMEOUT_MS) {
    const res = await fetchWithTimeout(url, init, timeout);
    if (!res.ok) {
        throw new UpstreamError(`${describe(res.status)} for ${shortUrl(url)}`, res.status);
    }
    return res.text();
}

export function shortUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return String(url);
    }
}

function describe(status) {
    return `upstream responded ${status}`;
}

/**
 * A browser-ish User-Agent is required by some providers (Genius in
 * particular rejects obviously automated clients).
 */
export const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function baseUrl(env, key, fallback) {
    const value = env?.[key];
    return typeof value === 'string' && value.length > 0 ? value.replace(/\/+$/, '') : fallback;
}
