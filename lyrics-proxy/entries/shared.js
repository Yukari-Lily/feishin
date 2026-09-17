/**
 * Shared plumbing for the platform entry points of the lyrics proxy.
 *
 * The proxy routes live at the root of the proxy service (/search, /get, ...)
 * but Vercel and EdgeOne Pages mount the function under /api/lyrics, so the
 * mount point is stripped before the router sees the request.
 */
export const BASE_PATH = '/api/lyrics';

export function toWorkerRequest(request) {
    const url = new URL(request.url);

    if (url.pathname === BASE_PATH) {
        url.pathname = '/';
    } else if (url.pathname.startsWith(`${BASE_PATH}/`)) {
        url.pathname = url.pathname.slice(BASE_PATH.length);
    }

    return new Request(url.toString(), request);
}

/** Node provides process.env, the V8 edge runtimes get env from the platform. */
export function getProcessEnv() {
    if (typeof process !== 'undefined' && process && process.env) return process.env;
    return {};
}