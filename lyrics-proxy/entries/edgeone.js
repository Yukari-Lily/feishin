/**
 * EdgeOne Pages Functions entry point for the lyrics proxy.
 * Generated into functions/api/lyrics/[[default]].js by
 * scripts/build-lyrics-proxy.mjs.
 */
import worker from '../src/index.js';
import { getProcessEnv, toWorkerRequest } from './shared.js';

const processEnv = getProcessEnv();

export function onRequest(context) {
    const waitUntil = context.waitUntil ?? ((task) => task);
    const env = { ...processEnv, ...(context.env ?? {}) };

    return worker.fetch(toWorkerRequest(context.request), env, { waitUntil });
}