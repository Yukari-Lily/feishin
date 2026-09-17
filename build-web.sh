#!/bin/bash
# Feishin web 构建脚本（Vercel / EdgeOne Pages 通用）
#
# 用法（平台构建命令，二选一；cwd 必须是仓库根目录）：
#   仓库内（推荐）：bash build-web.sh
#   gist：         curl -fsSL https://gist.githubusercontent.com/Yukari-Lily/276398b6e0285f7784eafdce9039465f/raw/edgeone -o /tmp/build.sh && bash /tmp/build.sh
#
# 环境变量（都可不填）：
#   DEFAULT_SETTINGS_FILE   默认设置 JSON 的本地路径；不填时优先用仓库根的 ./default-settings.json，再回落到 gist
#   DEFAULT_SETTINGS_URL    默认设置 JSON 的下载地址（gist 兜底）
#   LOAD_SETTINGS_VERSION   覆盖"默认设置已应用"标记；默认由 JSON 内容 sha256 前 12 位自动派生
#   SERVER_URL / SERVER_NAME / SERVER_TYPE / SERVER_LOCK / LEGACY_AUTHENTICATION / ANALYTICS_DISABLED / REMOTE_URL
#   FS_*                    见 settings.js.template（会被写入 out/web/settings.js）
#
# 产物：out/web/{index.html,settings.js,load-settings.js,sw.js,workbox-*.js,assets/*}
set -euo pipefail

echo "==> Node: $(node -v), npm: $(npm -v)"

# ── Node 版本提示（Vite 7 声明 >=20.19 或 >=22.12，但它自己也只是 warn）──────
# 实测：EdgeOne Pages 文档列出的可用版本（…18.20.4 / 20.18.0 / 22.11.0）都低于
# 这个要求，Vite 只打印一行警告、构建照常进行。所以这里也只警告、不中断，
# 保持和 Vite 一致的行为（早先的硬性 exit 1 会把 EdgeOne 的构建直接弄挂）。
node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
const ok = maj > 22 || (maj === 22 && min >= 12) || (maj === 20 && min >= 19);
if (!ok) {
  console.warn(
    "WARN: Node " + process.versions.node +
    " is below Vite 7 engines (>=20.19 or >=22.12); Vite warns too, build continues."
  );
}
'

# ── pnpm：优先 corepack，版本取自 package.json 的 packageManager ──────────────
PM_SPEC="$(node -p "require('./package.json').packageManager || ''" 2>/dev/null || true)"

if ! command -v pnpm >/dev/null 2>&1 && [ -n "$PM_SPEC" ] && command -v corepack >/dev/null 2>&1; then
  echo "==> corepack prepare $PM_SPEC"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare "$PM_SPEC" --activate >/dev/null 2>&1 || true
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if [ -n "$PM_SPEC" ]; then
    npm install -g "$PM_SPEC" --prefer-offline 2>/dev/null || npm install -g "$PM_SPEC"
  else
    npm install -g pnpm --prefer-offline 2>/dev/null || npm install -g pnpm
  fi
fi

echo "==> pnpm: $(pnpm -v)"

# EdgeOne/Vercel 通常已经 install 过，这里只兜底
if [ ! -d "node_modules" ]; then
  if [ -f "pnpm-lock.yaml" ]; then
    pnpm install --frozen-lockfile || pnpm install
  else
    pnpm install
  fi
else
  echo "==> node_modules exists, skip pnpm install"
fi

# 3414 个模块，默认堆容易 OOM；可用 NODE_OPTIONS 覆盖
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

# ── Patch web.vite.config.ts ──────────────────────────────────────────────────
# 做四件事 + 一个可选分包：
#   1. sourcemap: true  -> false
#   2. filename: 'assets/sw.js' -> 'sw.js'（SW 必须在站点根目录，见下）
#   3. scope: '/assets/' -> '/'
#   4. manifestFilename: 'assets/manifest.webmanifest' -> 'manifest.webmanifest'
#      平台的 header 规则里 /manifest.webmanifest 是 no-cache、/assets/* 是
#      immutable 一年，manifest 必须留在根目录才能命中 no-cache（vercel.json /
#      edgeone.json 里就是这么写的）。manifest 放根目录后，图标/截图的相对路径
#      会相对 / 解析，所以在配置里直接给 src 补 assets/ 前缀，后置修正就不需要了。
#   5. 插入 manualChunks（幂等）
#
# 为什么 SW 必须放根目录：仓库是 base: './'，workbox 生成的预缓存清单是相对路径
# （assets/xxx.js、index.html），而 workbox 用 new URL(entry, location.href) 解析，
# location 是 SW 脚本自身地址。SW 若在 /assets/sw.js，清单会变成
# /assets/assets/xxx.js 与 /assets/index.html（全 404）。
# workbox 运行时 workbox-<hash>.js 与 sw.js 同目录（workbox-build 的行为），
# 所以 sw.js 挪到根目录时它也会一起挪，最后会断言这一点。
node - << 'PATCHEOF'
const fs = require('fs');

const file = 'web.vite.config.ts';
const original = fs.readFileSync(file, 'utf8');
let content = original;
const notes = [];

function fail(msg) {
    console.error('PATCH FAILED: ' + msg);
    process.exit(1);
}

function replaceOnce(from, to, label) {
    if (!content.includes(from)) {
        if (content.includes(to)) {
            notes.push(label + ' (already applied)');
            return;
        }
        fail('anchor not found for ' + label + ': ' + JSON.stringify(from));
    }
    const first = content.indexOf(from);
    if (content.indexOf(from, first + 1) !== -1) {
        fail(label + ' anchor matched more than once: ' + JSON.stringify(from));
    }
    content = content.slice(0, first) + to + content.slice(first + from.length);
    notes.push(label);
}

replaceOnce('sourcemap: true', 'sourcemap: false', 'sourcemap -> false');
replaceOnce("filename: 'assets/sw.js'", "filename: 'sw.js'", 'sw filename -> sw.js');
replaceOnce("scope: '/assets/'", "scope: '/'", 'sw scope -> /');
replaceOnce(
    "manifestFilename: 'assets/manifest.webmanifest'",
    "manifestFilename: 'manifest.webmanifest'",
    'manifest filename -> manifest.webmanifest',
);

// manifest 放根目录后，图标/截图里的 src 必须补 assets/ 前缀（否则会解析到 /32x32.png）
const unprefixedSrc = (content.match(/src: '(?!assets\/)[^']+'/g) || []).length;
if (unprefixedSrc > 0) {
    content = content.replace(/src: '([^']+)'/g, (m, p1) =>
        p1.startsWith('assets/') ? m : "src: 'assets/" + p1 + "'",
    );
    notes.push('manifest src -> assets/ (' + unprefixedSrc + ')');
} else {
    notes.push('manifest src (already applied)');
}

// 视觉器/波形库体积大，拆成独立 chunk；这些包在 v1.17.0 的 package.json 里仍然存在
const manualChunks = `
                manualChunks: {
                    'vendor-butterchurn': ['butterchurn', 'butterchurn-presets'],
                    'vendor-audiomotion': ['audiomotion-analyzer'],
                    'vendor-wavesurfer': ['wavesurfer.js', '@wavesurfer/react'],
                },`;

if (content.includes('manualChunks')) {
    notes.push('manualChunks (already applied)');
} else {
    const hits = content.split('output: {').length - 1;
    if (hits !== 1) {
        fail('expected exactly one "output: {" in ' + file + ', found ' + hits);
    }
    content = content.replace('output: {', 'output: {' + manualChunks);
    notes.push('manualChunks');
}

// manifest 必须留在站点根目录：平台的 header 规则里 /manifest.webmanifest 是
// no-cache，而 /assets/* 是 immutable 一年（见 vercel.json / edgeone.json）。
const checks = [
    [content.includes("base: './'"), "base: './' disappeared"],
    [content.includes('sourcemap: false'), 'sourcemap: false missing'],
    [content.includes("filename: 'sw.js'"), "filename: 'sw.js' missing"],
    [content.includes("scope: '/'"), "scope: '/' missing"],
    [content.includes('manualChunks'), 'manualChunks missing'],
    [
        content.includes("manifestFilename: 'manifest.webmanifest'"),
        "manifestFilename: 'manifest.webmanifest' missing (must stay at the site root)",
    ],
    [
        !/src: '(?!assets\/)/.test(content),
        'some manifest icon/screenshot src is not prefixed with assets/',
    ],
    [
        !content.includes('navigateFallback'),
        'navigateFallback appeared in web.vite.config.ts. The effective default ' +
            "('index.html') is fine for this SPA - review this line, then relax this check if intended.",
    ],
];
for (const [ok, msg] of checks) {
    if (!ok) fail(msg);
}

if (content !== original) {
    fs.writeFileSync(file, content);
}
console.log('[patch] ' + notes.join(', '));
PATCHEOF

grep -q "sourcemap: false" web.vite.config.ts || { echo "PATCH FAILED: sourcemap"; exit 1; }
grep -q "filename: 'sw.js'" web.vite.config.ts || { echo "PATCH FAILED: sw filename"; exit 1; }
grep -q "scope: '/'" web.vite.config.ts || { echo "PATCH FAILED: sw scope"; exit 1; }
grep -q "manifestFilename: 'manifest.webmanifest'" web.vite.config.ts || { echo "PATCH FAILED: manifest"; exit 1; }
grep -q "manualChunks" web.vite.config.ts || { echo "PATCH FAILED: manualChunks"; exit 1; }

if grep -q "navigateFallback" web.vite.config.ts; then
  echo "PATCH FAILED: navigateFallback should not exist"
  exit 1
fi

echo "==> All patches verified ✓"

# ── 构建 ──────────────────────────────────────────────────────────────────────
pnpm exec vite build --config web.vite.config.ts

# ── 生成 settings.js ─────────────────────────────────────────────────────────
# 值会被放进 "..." 里，必须转义反斜杠/双引号并去掉换行，否则
# FS_GENERAL_PATH_REPLACE（Windows 路径）、FS_PLAYBACK_FILTERS（JSON）、
# FS_CSS_CONTENT（可能含引号）会直接生成语法错误的 settings.js。
node - << 'EOF'
const fs = require("fs");
const p = process.env;

const bool = (k) => (String(p[k] || "").trim().toLowerCase() === "true" ? "true" : "false");
const str = (k) => (p[k] == null ? "" : String(p[k]));
const esc = (v) =>
  String(v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");

if (!fs.existsSync("settings.js.template")) {
  console.error("settings.js.template not found.");
  process.exit(1);
}

let t = fs.readFileSync("settings.js.template", "utf8");

t = t
  .replaceAll("${SERVER_URL}", () => esc(str("SERVER_URL")))
  .replaceAll("${SERVER_NAME}", () => esc(str("SERVER_NAME")))
  .replaceAll("${SERVER_TYPE}", () => esc(str("SERVER_TYPE")))
  .replaceAll("${SERVER_LOCK}", () => bool("SERVER_LOCK"))
  .replaceAll("${LEGACY_AUTHENTICATION}", () => bool("LEGACY_AUTHENTICATION"))
  .replaceAll("${ANALYTICS_DISABLED}", () => bool("ANALYTICS_DISABLED"))
  .replaceAll("${REMOTE_URL}", () => esc(str("REMOTE_URL")))
  .replace(/\$\{(FS_[A-Z0-9_]+)\}/g, (_, k) => esc(p[k] != null ? p[k] : ""));

if (/\$\{[A-Z0-9_]+\}/.test(t)) {
  console.error("Unresolved placeholders remain in settings.js.");
  process.exit(1);
}

fs.mkdirSync("out/web", { recursive: true });
fs.writeFileSync("out/web/settings.js", t, "utf8");

console.log("Generated out/web/settings.js");
EOF

# ── 自动提取 store_settings 版本号 ────────────────────────────────────────────
SETTINGS_VERSION=$(node - << 'EOF'
const fs = require("fs");

const path = "src/renderer/store/settings.store.ts";

if (!fs.existsSync(path)) {
  console.error("[error] src/renderer/store/settings.store.ts not found");
  process.exit(1);
}

const src = fs.readFileSync(path, "utf8");
const nameIdx = src.indexOf("name: 'store_settings'");

if (nameIdx === -1) {
  console.error("[error] store_settings not found in settings.store.ts");
  process.exit(1);
}

const after = src.slice(nameIdx);
const match = after.match(/version:\s*(\d+)/);

if (!match) {
  console.error("[error] version not found after store_settings");
  process.exit(1);
}

console.log(match[1]);
EOF
)

export SETTINGS_VERSION
echo "==> Detected store_settings version: ${SETTINGS_VERSION} ✓"

# ── 准备默认设置 JSON ─────────────────────────────────────────────────────────
# 优先级：DEFAULT_SETTINGS_FILE > 仓库根 ./default-settings.json > gist
# 把 default-settings.json 提交进仓库可以绕开 gist raw 的 CDN 缓存（改完 gist 立刻
# 重新部署可能拿到旧文件），也让"构建结果"完全由仓库决定。
DEFAULT_SETTINGS_URL="${DEFAULT_SETTINGS_URL:-https://gist.githubusercontent.com/Yukari-Lily/276398b6e0285f7784eafdce9039465f/raw/default-settings.json}"

if [ -z "${DEFAULT_SETTINGS_FILE:-}" ] && [ -f "./default-settings.json" ]; then
  DEFAULT_SETTINGS_FILE="./default-settings.json"
fi

if [ -n "${DEFAULT_SETTINGS_FILE:-}" ]; then
  echo "==> Using DEFAULT_SETTINGS_FILE: ${DEFAULT_SETTINGS_FILE}"
  cp "${DEFAULT_SETTINGS_FILE}" /tmp/default-settings.json
else
  echo "==> Downloading default settings JSON"
  echo "    ${DEFAULT_SETTINGS_URL}"
  curl -fsSL --show-error "${DEFAULT_SETTINGS_URL}" -o /tmp/default-settings.json
fi

# ── 生成 load-settings.js：启动前预写，无 reload ─────────────────────────────
# 只填充缺失项，不覆盖用户已有设置；只在全新 store 上写 version。
cat > /tmp/load-settings.template.js << 'JSEOF'
(function () {
  var INIT_KEY = "__INIT_KEY__";

  if (localStorage.getItem(INIT_KEY)) return;

  var defaults = __SETTINGS_JSON__;
  var defaultsVersion = __DEFAULTS_VERSION__;

  try {
    var raw = localStorage.getItem("store_settings");
    var wrapper = null;
    var isNewStore = false;

    if (raw) {
      try {
        wrapper = JSON.parse(raw);
      } catch (e) {
        wrapper = null;
      }
    }

    // 情况 1：全新用户
    if (!wrapper || typeof wrapper !== "object") {
      wrapper = {
        state: {},
        version: defaultsVersion
      };
      isNewStore = true;
    }

    // 情况 2：旧版扁平结构
    else if (!wrapper.state || typeof wrapper.state !== "object") {
      var flatState = wrapper;
      var flatVersion = flatState.version;
      // 扁平结构里的 version 是元数据，不属于 state
      delete flatState.version;
      wrapper = {
        state: flatState,
        version: flatVersion
      };
    }

    // 只在全新 store 或没有 version 时写入版本号。
    // 写的是默认设置 JSON 自己的版本（defaultsVersion），不是构建时的版本：
    // JSON 比构建旧时，Feishin 自己的 migrate 会照常跑，不会把旧形状当成新版状态。
    if (isNewStore || wrapper.version == null) {
      wrapper.version = defaultsVersion;
    }

    // 只填充缺失项，不覆盖用户已有设置。
    Object.keys(defaults || {}).forEach(function (k) {
      if (k === "version") return;
      if (wrapper.state[k] === undefined) {
        wrapper.state[k] = defaults[k];
      }
    });

    localStorage.setItem("store_settings", JSON.stringify(wrapper));
    localStorage.setItem(INIT_KEY, "1");

    // 不要 location.reload()
    // 这个脚本被注入在 <head>，Feishin/Zustand 启动前已经写好 localStorage。
  } catch (e) {
    console.warn("[load-settings] Failed to apply defaults:", e);
    localStorage.setItem(INIT_KEY, "1");
  }
})();
JSEOF

node - << 'EOF'
const crypto = require('crypto');
const fs = require('fs');

const STORE_VERSION = Number(process.env.SETTINGS_VERSION);
if (!Number.isInteger(STORE_VERSION)) {
    console.error('Invalid SETTINGS_VERSION: ' + process.env.SETTINGS_VERSION);
    process.exit(1);
}

// ── 读取并规范化默认设置 JSON ────────────────────────────────────────────────
const raw = fs.readFileSync('/tmp/default-settings.json', 'utf8');
let parsed;
try {
    parsed = JSON.parse(raw);
} catch (e) {
    console.error('default-settings.json is not valid JSON: ' + e.message);
    process.exit(1);
}
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('default-settings.json must be a JSON object');
    process.exit(1);
}

// 同时接受扁平对象（导出的设置）与 zustand 的 { state, version } 包装
let state = parsed;
let declaredVersion = parsed.version;
if (parsed.state && typeof parsed.state === 'object' && !Array.isArray(parsed.state)) {
    state = parsed.state;
    declaredVersion = parsed.version;
}

for (const slice of ['general', 'lyrics', 'playback']) {
    if (!state[slice] || typeof state[slice] !== 'object' || Array.isArray(state[slice])) {
        console.error('default-settings.json looks wrong: missing slice "' + slice + '"');
        process.exit(1);
    }
}

state = JSON.parse(JSON.stringify(state));
delete state.version;

if (state.remote && typeof state.remote === 'object' && 'password' in state.remote) {
    delete state.remote.password;
    console.log('[defaults] stripped remote.password (falls back to a per-browser random one)');
}
if ('tab' in state) {
    console.log('[defaults] note: "tab" is present; new visitors will open Settings on that tab');
}

// 默认设置 JSON 的版本 <= 构建版本时按 JSON 的版本写，让 Feishin 的 migrate 能跑
let defaultsVersion = STORE_VERSION;
if (declaredVersion !== undefined && declaredVersion !== null && declaredVersion !== '') {
    const n = Number(declaredVersion);
    if (Number.isInteger(n)) {
        if (n > STORE_VERSION) {
            console.warn(
                '[warn] default-settings.json version ' +
                    n +
                    ' > build store version ' +
                    STORE_VERSION +
                    '; clamping to ' +
                    STORE_VERSION,
            );
            defaultsVersion = STORE_VERSION;
        } else {
            defaultsVersion = n;
        }
    } else {
        console.warn('[warn] ignoring non-numeric version: ' + JSON.stringify(declaredVersion));
    }
}

if (defaultsVersion < STORE_VERSION) {
    console.warn(
        '[warn] default-settings.json is from store version ' +
            defaultsVersion +
            ', build expects ' +
            STORE_VERSION +
            '; Feishin migrations will run on the injected state.',
    );
}

const defaultsJson = JSON.stringify(state);
const hash = crypto.createHash('sha256').update(defaultsJson).digest('hex').slice(0, 12);
const version = process.env.LOAD_SETTINGS_VERSION || hash;
const initKey = '_feishin_defaults_applied_' + version;

let t = fs.readFileSync('/tmp/load-settings.template.js', 'utf8');
t = t
    .replace('__INIT_KEY__', () => initKey)
    .replace('__SETTINGS_JSON__', () => defaultsJson)
    .replace('__DEFAULTS_VERSION__', () => String(defaultsVersion));

if (/__[A-Z_]+__/.test(t)) {
    console.error('Unresolved placeholder remains in load-settings.js');
    process.exit(1);
}

fs.mkdirSync('out/web', { recursive: true });
fs.writeFileSync('out/web/load-settings.js', t, 'utf8');
fs.writeFileSync('/tmp/load-settings.version', version, 'utf8');

const size = fs.statSync('out/web/load-settings.js').size;
console.log(
    'Generated out/web/load-settings.js (initKey=' +
        initKey +
        ', defaultsVersion=' +
        defaultsVersion +
        ', ' +
        size +
        ' bytes)',
);
EOF

# ── 注入 index.html ───────────────────────────────────────────────────────────
export LOAD_SETTINGS_VERSION="$(cat /tmp/load-settings.version)"
export LOAD_SETTINGS_SRC="./load-settings.js?v=${LOAD_SETTINGS_VERSION}"

node - << 'EOF'
const fs = require('fs');

const p = 'out/web/index.html';
let html = fs.readFileSync(p, 'utf8');
const script = '<script src="' + process.env.LOAD_SETTINGS_SRC + '"></script>';

if (html.includes('load-settings.js')) {
    html = html.replace(
        /<script\s+src=["'][^"']*load-settings\.js[^"']*["']\s*>\s*<\/script>/,
        () => script,
    );
    console.log('==> Updated existing load-settings.js injection ✓');
} else {
    if (!html.includes('<head>')) {
        console.error('PATCH FAILED: <head> not found in out/web/index.html');
        process.exit(1);
    }
    html = html.replace('<head>', () => '<head>' + script);
    console.log('==> Injected load-settings.js into index.html ✓');
}

if (!html.includes(process.env.LOAD_SETTINGS_SRC)) {
    console.error('PATCH FAILED: load-settings.js not present in index.html after injection');
    process.exit(1);
}

fs.writeFileSync(p, html, 'utf8');
EOF

# ── 最终检查 ──────────────────────────────────────────────────────────────────
echo "==> Final output check:"
for f in \
  out/web/index.html \
  out/web/settings.js \
  out/web/load-settings.js \
  out/web/sw.js \
  out/web/manifest.webmanifest
do
  if [ ! -f "$f" ]; then
    echo "FINAL CHECK FAILED: missing $f"
    exit 1
  fi
done

# sw.js 在根目录，workbox 运行时必须跟着在根目录，否则 SW 安装失败（PWA 静默失效）
WORKBOX_REF="$(grep -o 'workbox-[0-9a-f]\{8,\}' out/web/sw.js | head -1 || true)"
if [ -z "$WORKBOX_REF" ]; then
  echo "FINAL CHECK FAILED: no workbox runtime reference found in out/web/sw.js"
  exit 1
fi
if [ ! -f "out/web/${WORKBOX_REF}.js" ]; then
  echo "FINAL CHECK FAILED: out/web/${WORKBOX_REF}.js missing (service worker would fail to install)"
  exit 1
fi
if [ -f "out/web/assets/${WORKBOX_REF}.js" ]; then
  echo "FINAL CHECK FAILED: workbox runtime left under assets/ while sw.js is at the root"
  exit 1
fi
echo "==> SW runtime co-located: out/web/${WORKBOX_REF}.js ✓"

grep -q "register('./sw.js'" out/web/index.html || { echo "FINAL CHECK FAILED: sw registration not pointing at ./sw.js"; exit 1; }
grep -q "scope: '/'" out/web/index.html || { echo "FINAL CHECK FAILED: sw registration scope is not '/'"; exit 1; }
if grep -q "assets/sw.js" out/web/index.html; then
  echo "FINAL CHECK FAILED: index.html still references assets/sw.js"
  exit 1
fi
grep -q "load-settings.js" out/web/index.html || { echo "FINAL CHECK FAILED: load-settings.js not injected"; exit 1; }

# manifest 必须在根目录（否则会落到 /assets/* 的 immutable 缓存规则上）
grep -q 'href="./manifest.webmanifest"' out/web/index.html || { echo "FINAL CHECK FAILED: index.html does not link ./manifest.webmanifest"; exit 1; }
if grep -q "assets/manifest.webmanifest" out/web/index.html; then
  echo "FINAL CHECK FAILED: index.html still references assets/manifest.webmanifest"
  exit 1
fi
if [ -f "out/web/assets/manifest.webmanifest" ]; then
  echo "FINAL CHECK FAILED: manifest left under assets/ (would be cached immutable for a year)"
  exit 1
fi

if grep -qE '\$\{[A-Z0-9_]+\}' out/web/settings.js; then
  echo "FINAL CHECK FAILED: unresolved \${...} in out/web/settings.js"
  exit 1
fi

node --check out/web/load-settings.js || { echo "FINAL CHECK FAILED: load-settings.js is not valid JS"; exit 1; }
node --check out/web/settings.js || { echo "FINAL CHECK FAILED: settings.js is not valid JS"; exit 1; }

echo "==> Final output check passed ✓"
ls -lh out/web/index.html out/web/settings.js out/web/load-settings.js out/web/sw.js "out/web/${WORKBOX_REF}.js" out/web/manifest.webmanifest

echo ""
echo "==> JS chunk sizes (top 10):"
ls -lhS out/web/assets/*.js 2>/dev/null | head -10 || true

echo "==> Build complete ✓"
exit 0