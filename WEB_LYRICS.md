# Web lyrics fetching

This fork adds internet lyrics fetching to the **web build** of Feishin.

Upstream, remote lyrics are resolved in the Electron main process
(`src/main/features/core/lyrics`) and handed to the renderer over IPC. The web
build has no main process, so `lyrics-api.ts` used to fall back to `null` and
the player page showed nothing but whatever lyrics the music server itself
stored. This fork implements the same three lookups in the renderer, so the
automatic lookup on the player page and the manual search panel both work in a
browser.

## What changes

| File | Change |
| --- | --- |
| `src/renderer/features/lyrics/api/web-lyrics-api.ts` | **new** - browser implementation of the three remote lyric lookups (provider registry, ranking, transports) |
| `src/renderer/features/lyrics/api/lyrics-api.ts` | one line: `isElectron() ? window.api.lyrics : webLyricsApi` |
| `src/renderer/features/lyrics/lyrics-actions.tsx` | show the "Search" button in the web build when a remote source is usable |
| `src/renderer/features/settings/components/general/lyric-settings.tsx` | unhide fetch / prefer local / providers in the web build, add the provider URL field |
| `src/renderer/features/lyrics/components/lyrics-settings-form.tsx` | same unhiding for the in-player settings panel |
| `src/renderer/store/settings.store.ts` | new persisted setting `lyrics.proxyUrl` |
| `src/renderer/store/env-settings-overrides.ts` | new `FS_LYRICS_PROXY_URL` env override |
| `src/renderer/global.d.ts` | type for `window.FS_LYRICS_PROXY_URL` |
| `settings.js.template` | expose `FS_LYRICS_PROXY_URL` to the Docker/nginx deployment |
| `Dockerfile`, `docker-compose.yaml` | document the `FS_LYRICS_PROXY_URL` variable |
| `src/i18n/locales/en.json`, `src/i18n/locales/zh-Hans.json` | strings for the new setting |
| `lyrics-proxy/` | **new** - the lyrics proxy itself, vendored so the web app can serve it from its own origin |
| `api/lyrics/[...path].mjs` | **new**, generated - Vercel Functions entry point for the proxy |
| `functions/api/lyrics/[[default]].js` | **new**, generated - EdgeOne Pages Functions entry point |
| `lyrics-proxy/entries/` | **new** - readable wrapper sources for the two platforms |
| `scripts/build-lyrics-proxy.mjs` | **new** - regenerates both platform entry points (no dependency changes needed) |
| `eslint.config.mjs` | ignore the vendored proxy source and its generated bundles |
| `WEB_LYRICS.md` | this document |

Nothing in the Electron build changes behaviour: when `isElectron()` is true the
renderer still calls `window.api.lyrics` exactly as before.

## How it works

`web-lyrics-api.ts` exposes the same three methods the preload script exposes:

```
searchRemoteLyrics(params)        -> Record<LyricSource, InternetProviderLyricSearchResponse[]>
getRemoteLyricsByRemoteId(query)  -> string | null            // raw LRC or plain text
getRemoteLyricsBySong(song)       -> InternetProviderLyricResponse | null
```

Because `lyrics-api.ts` only selects an implementation and every caller in it is
unchanged, the existing UI logic keeps working as-is: `lyrics.tsx` still decides
local vs remote with `computeSelectedFromResult`, the manual search panel still
groups by provider, previews a candidate and applies an override.

Two transports are used per provider:

- **direct** - `lrclib.net` and `api-lyrics.simpmusic.org` answer with
  `Access-Control-Allow-Origin: *`, so the browser can query them itself. This
  means the web build has working lyrics search even without deploying
  anything.
- **proxy** - NetEase and Genius send no CORS headers, and both need request
  headers a browser is not allowed to set (`Referer`, `User-Agent`); Genius also
  blocks most datacenter traffic. They are served by the companion Cloudflare
  Worker in `../feishin-lyrics-worker`, which mirrors the same provider logic.

When a proxy URL is configured it is preferred for every provider (it sends
proper User-Agent headers and caches at the edge); if a proxy request fails, the
CORS friendly providers fall back to a direct call.

### Ranking parity

Candidate scoring reuses the exact algorithm of the desktop build: Fuse.js over
`name` + `artist` with the same weights, a sync-first tie break, and the same
`0.55` match threshold in the automatic path. `orderSearchResults()` is mirrored
from `src/main/features/core/lyrics/shared.ts` inside `web-lyrics-api.ts`,
because the renderer is not allowed to import from the main process tree (see
`docs/agents/architecture.md`). If the main process version changes, update the
copy.

## Serving the proxy from the web deployment

The proxy (`lyrics-proxy/`) is vendored into this repo and generated into the
entry point each platform looks for, so a deployment of this fork gives the web
app a proxy on its **own origin** at `/api/lyrics`:

| Platform | Generated file | Detected automatically |
| --- | --- | --- |
| Vercel | `api/lyrics/[...path].mjs` (`export function GET(request)`) | yes |
| EdgeOne Pages | `functions/api/lyrics/[[default]].js` (`export function onRequest(context)`) | yes |
| Docker / nginx (or anything else) | run `lyrics-proxy/` next to the app and reverse proxy `/api/lyrics` to it | yes |
| Cloudflare Workers | `feishin-lyrics-worker` project (separate deployment) | no, set its URL |

Because the proxy lives on the same origin, there is no CORS, no mixed content
and no URL to configure: on startup the web build probes `/api/lyrics/health`
once and uses it when it answers with the expected service payload. A same
origin deployment is therefore the recommended setup, and the "Lyrics provider
URL" setting only exists for a proxy hosted elsewhere (an absolute URL, or a
relative path such as `/api/lyrics` to skip the probe).

After editing anything under `lyrics-proxy/src/`, regenerate the entry points
and commit them (neither platform runs the generator itself):

```bash
node scripts/build-lyrics-proxy.mjs                 # regenerate the two entry points
node --test lyrics-proxy/test/*.test.mjs            # 56 offline tests for the vendored source
```

Neither `package.json` nor `pnpm-lock.yaml` is touched by this fork, which keeps
upstream merges conflict free for the two files that change most often.

## Configuration

1. **In the UI** - Settings -> Lyrics -> "Lyrics provider URL". Stored in the
   renderer settings (`lyrics.proxyUrl`), so it survives reloads and takes
   precedence over the environment default. Accepts an absolute URL or a
   same-origin path such as `/api/lyrics`.
2. **By environment** - `FS_LYRICS_PROXY_URL`, which the Docker image injects
   through `settings.js`:

   ```yaml
   environment:
       - FS_LYRICS_PROXY_URL=https://feishin-lyrics-worker.example.workers.dev
   ```

With no proxy configured the web build still fetches from LRCLib and SimpMusic
as long as those providers are enabled in Settings -> Lyrics -> Providers; with
the vendored proxy it also reaches NetEase and Genius with no configuration.

## Provider support in the browser

| Provider | Web support | Notes |
| --- | --- | --- |
| LRCLib | direct + proxy | best synced lyrics, works with no deployment |
| SimpMusic | direct + proxy | works with no deployment, search by track name only |
| NetEase | proxy only | needs the proxy for CORS and the `Referer` header |
| Genius | proxy only | plain text only, frequently 403s from datacenter IPs |

## Verifying a build

```bash
pnpm typecheck            # tsc over the web/electron renderer project
pnpm build:web            # produces out/web, the bundle Docker serves
node --test lyrics-proxy/test/*.test.mjs   # offline tests for the vendored proxy
```

Manual check after deploying the web bundle: open the player page with a song
that has no lyrics on the music server. With "Fetch lyrics from the internet"
enabled, the lyrics panel should fill in from LRCLib/SimpMusic (or from the
proxy), and the Search button at the bottom of the lyrics panel should open the
provider search modal.

To check a deployed proxy directly:

```bash
curl https://your-feishin.example.com/api/lyrics/health
# {"ok":true,"service":"feishin-lyrics-worker","sources":[...],...}
```
