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
| `POST /api/lyrics/translate` | optional deployment AI translation; JSON body `{ "lines": ["..."] }` |

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
| `LYRICS_AI_URL` | unset | complete Chat Completions compatible endpoint, e.g. `https://your-provider.example/v1/chat/completions` |
| `LYRICS_AI_API_KEY` | unset | server-side bearer API key for translation |
| `LYRICS_AI_MODEL` | unset | model ID supported by the configured endpoint |
| `LYRICS_AI_TARGET_LANGUAGE` | `Simplified Chinese` | translation target language |

Provider searches require no API keys. On the Node.js based runtimes caching is handled by
the CDN through the `Cache-Control` header; the V8 runtimes (Cloudflare,
EdgeOne) additionally use the Cache API when the runtime exposes it.

## Automatic translation

Set all three `LYRICS_AI_URL`, `LYRICS_AI_API_KEY`, and `LYRICS_AI_MODEL` variables
on the function deployment to enable translation. These are runtime server secrets,
not `VITE_*` settings or values to inject into browser `settings.js`. No client API
key is needed: the browser never sees them.

The health response advertises whether translation is enabled plus a short
`translationTag`, a hash of the model, target language and prompt version. The web
client puts that tag in its cache key and persists finished translations in
IndexedDB, so switching `LYRICS_AI_MODEL` (or the target language) makes every
browser request the song again instead of showing the old wording, while an
unchanged deployment keeps serving what it already has.

The player displays original lyrics immediately, then adds translated lines in the
background when the **AI lyrics translation** switch is enabled. The switch is on by
default and sits below **NetEase translations** in both Lyrics settings panels. This
also works for selected local lyrics and manual search previews. Existing inline
translations or a selected local song's structured translation layer skip AI.
The original timestamps and karaoke word cues are preserved. Model output
must have exactly one nonempty translation per submitted line; failures keep the
original display. Translation augments the display and does not write music files
or lyrics back to the music server.

Requests accept up to 150 lines, 400 characters per line and 10,000 characters in
total, which covers a full lyric sheet with room to spare.

Each service instance allows two concurrent calls, 15 calls per client address and
30 calls in total per minute, deduplicates in-flight requests, and caches up to 100
successful translations for 24 hours. These counters live in the instance, so on a
platform that starts an instance per request they bound bursts rather than provide a
global quota: a real quota belongs in a platform rate limit rule or the provider's
own budget. Exceeding a limit answers 429 with `Retry-After`, and a second concurrent
translation on the same instance answers 503, so the browser only backs off for the
per client limit. The browser also caches translations.
The translation endpoint uses `Cache-Control: no-store` because it accepts local lyrics.

A song is still translated in a single upstream request, so the model keeps the whole
song as context. Delivery is incremental: a caller that sends `Accept: text/event-stream`
receives one `event: line` per finished line (`{"i":0,"t":"..."}`), then a single
`event: done` carrying the complete array. A caller that sends no `Accept` header
receives the previous single JSON body, so older web bundles keep working while a
deployment rolls out. `X-Accel-Buffering: no` is set for reverse proxies; a platform
that buffers anyway still returns correct data, just all at once.

Timeouts are idle based rather than total, so a slow or reasoning model is not cut off
mid-song: 45 seconds are allowed before the first token and 30 seconds between chunks.
A line the model cannot deliver is replaced by the original text instead of discarding
the song, and a stream that ends early keeps everything that already arrived. Only a
complete translation is cached.

Check whether a deployment really streams (the first event should arrive long before
the last):

```bash
curl -sN -X POST https://your-feishin.example.com/api/lyrics/translate \
    -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
    -d '{"name":"test","artist":"test","lines":["one","two","three"]}' \
    -w '\n[total %{time_total}s]\n'
```

Vercel needs `maxDuration` raised for the function (already set in `vercel.json`);
EdgeOne's limit is set in the EdgeOne console.

Vercel and EdgeOne use the included function entry points. A static Docker/nginx
deployment must point `FS_LYRICS_PROXY_URL` at a running lyrics proxy; setting AI
environment variables on nginx alone cannot execute translation. Desktop builds
can use an explicitly configured lyrics proxy URL for this feature.

## Candidate selection

Desktop and web share artist normalization (including group members and `CV:` tags),
title matching, and a title-only search fallback. At most five matching candidates
are fetched per search. Candidates with substantial translated text rank ahead of
original-only lyrics; empty, credit-only, and much shorter fragments are excluded
from automatic selection. Title/version, artist, and available duration checks still
apply. Completeness is a body-length heuristic, not a guarantee from the provider.
The existing NetEase translation setting continues to control display of its translations.

## Tests

The vendored source keeps its own dependency free suite:

```bash
node --test lyrics-proxy/test/*.test.mjs                        # 75 offline tests
RUN_LIVE=1 node --test lyrics-proxy/test/live.test.mjs          # live smoke tests
```
