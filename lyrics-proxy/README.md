# lyrics-proxy

Internet lyrics proxy used by the web build of this fork.

It is vendored into the app repo so the web app can serve it from its **own
origin** at `/api/lyrics`, which removes CORS from the picture and works on
every deployment of this repo (Vercel, EdgeOne Pages, Docker/nginx, ...).

## Routes

| Route | Purpose |
| --- | --- |
| `GET /api/lyrics/health` | deployment check; the web app also uses it to auto-detect a same-origin proxy |
| `GET /api/lyrics/search?source=&name=&artist=&album=&duration=` | provider search, returns `{ results: [...] }` |
| `GET /api/lyrics/get?source=&id=[&translate=1]` | raw LRC/plain lyrics for one result |

Source slugs: `lrclib`, `netease`, `simpmusic`, `genius`.

## Platform entry points

Both files are **generated** by `scripts/build-lyrics-proxy.mjs` from
`src/index.js` and committed, so neither platform needs an extra build step:

| Platform | File | Handler |
| --- | --- | --- |
| Vercel (Functions) | `api/lyrics/[...path].mjs` | `export function GET(request)` |
| EdgeOne Pages (Functions) | `functions/api/lyrics/[[default]].js` | `export function onRequest(context)` |
| Cloudflare Workers | separate `feishin-lyrics-worker` project | `export default { fetch }` |

Regenerate after editing `src/`:

```bash
node scripts/build-lyrics-proxy.mjs
```

## Configuration

Environment variables (all optional, defaults are safe):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENABLED_SOURCES` | all four | comma separated allow list |
| `ALLOWED_ORIGIN` | `*` | `Access-Control-Allow-Origin` (only relevant for cross-origin use) |
| `CACHE_TTL_SECONDS` | `3600` | edge cache TTL, sent as `Cache-Control` |
| `UPSTREAM_TIMEOUT_MS` | `8000` | upstream request timeout |
| `LRCLIB_BASE_URL`, `NETEASE_BASE_URL`, `SIMPMUSIC_BASE_URL`, `GENIUS_BASE_URL` | official hosts | mirror overrides |

No API keys are required. On the Node.js based runtimes caching is handled by
the CDN through the `Cache-Control` header; the V8 runtimes (Cloudflare,
EdgeOne) additionally use the Cache API when the runtime exposes it.

## Tests

The vendored source keeps its own dependency free suite:

```bash
node --test lyrics-proxy/test/*.test.mjs                        # 56 offline tests
RUN_LIVE=1 node --test lyrics-proxy/test/live.test.mjs          # live smoke tests
```
