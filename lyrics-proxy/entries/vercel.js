/**
 * Vercel Functions entry point for the lyrics proxy.
 * Generated into api/lyrics/[...path].mjs by scripts/build-lyrics-proxy.mjs.
 */
import worker from '../src/index.js';
import { getProcessEnv, toWorkerRequest } from './shared.js';

const env = getProcessEnv();

export function GET(request) {
    return worker.fetch(toWorkerRequest(request), env, {});
}

export function OPTIONS(request) {
    return worker.fetch(toWorkerRequest(request), env, {});
}