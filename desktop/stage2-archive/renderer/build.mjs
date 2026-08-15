// Phase 2 renderer build: scan the repo's dsh.client roster into manifest.json,
// bundle the shell + shims + boot into one inline HTML page (no build-time
// network, no dev server, no file:// subresource loads at runtime).
import { build } from 'esbuild'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RENDERER = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(RENDERER, '..', '..', 'repo')

// v1 exclusions: kernel-static entries and packages whose host rows this
// desktop composition does not mount yet.
const EXCLUDE = new Set([
  '@deepseek-ai/dsh-client-modules', // kernel registers it statically
  '@deepseek-ai/dsh-client-hmr', // dev-only reload chain
  '@deepseek-ai/dsh-session-log-export', // host row not mounted yet
  '@deepseek-ai/dsh-cordis-client-runner', // v1: skip dynamic cordis UI
  '@deepseek-ai/dsh-client-ui-cordis', // v1: skip dynamic cordis UI (needs cordis-client-runner)
  // The two directory-picker surfaces are MUTUALLY EXCLUSIVE (the official
  // directory-picker-auto host plugin mounts exactly one per boot). The
  // desktop composition pins -native, so the browse surface must not load:
  // both register the same slot "conversation.hero.workspace.directoryFlow"
  // and double registration throws during assembly.
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
])

function scanManifest() {
  const entries = []
  const skipped = []
  const packagesRoot = path.join(REPO, 'packages')
  for (const area of readdirSync(packagesRoot)) {
    const areaDir = path.join(packagesRoot, area)
    if (!statSync(areaDir).isDirectory()) continue
    for (const pkgName of readdirSync(areaDir)) {
      const pkgJsonPath = path.join(areaDir, pkgName, 'package.json')
      if (!existsSync(pkgJsonPath)) continue
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
      const client = pkg.dsh?.client
      if (!client || client.platform !== 'web') continue
      if (EXCLUDE.has(pkg.name)) continue
      const bundlePath = path.join('packages', area, pkgName, 'lib', 'client.js')
      if (!existsSync(path.join(REPO, bundlePath))) {
        skipped.push(pkg.name)
        continue
      }
      entries.push({
        id: pkg.name,
        url: `/plugins/${pkg.name}.js`,
        rev: 'desktop',
        inject: client.inject ?? [],
        immediately: client.immediately ?? false,
        bundlePath,
      })
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return { entries, skipped }
}

const manifest = scanManifest()
writeFileSync(path.join(RENDERER, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`[build] manifest: ${manifest.entries.length} entries, skipped (no lib/client.js): ${manifest.skipped.join(', ') || 'none'}`)

await build({
  entryPoints: [path.join(RENDERER, 'entry.js')],
  bundle: true,
  outfile: path.join(RENDERER, 'entry.bundle.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  jsx: 'automatic',
  // Mirror the official apps/web vite alias table: the shell family MUST be
  // compiled from src. The built lib artifacts externalize every CSS import
  // into a stub module (rolldown emits `\0dsh-css-stub:<file>` and the import
  // resolves to `{}`), so consuming lib leaves every ui-primitives
  // className empty — dialogs/buttons/menus render as unstyled text (the
  // "settings overlay" defect). Official vite compiles src directly so CSS
  // rides its pipeline; esbuild does the same here.
  alias: {
    '@deepseek-ai/dsh-client-web': path.join(REPO, 'packages', 'client', 'web', 'src', 'boot.tsx'),
    '@deepseek-ai/dsh-client-web-react': path.join(REPO, 'packages', 'client', 'web-react', 'src', 'index.ts'),
    '@deepseek-ai/dsh-client-ui-slots': path.join(REPO, 'packages', 'client', 'ui-slots', 'src', 'index.ts'),
    '@deepseek-ai/dsh-client-ui-primitives': path.join(REPO, 'packages', 'client', 'ui-primitives', 'src', 'index.ts'),
    '@deepseek-ai/dsh-client-ui-attachment': path.join(REPO, 'packages', 'client', 'ui-attachment', 'src', 'index.ts'),
    '@deepseek-ai/dsh-client-schema-form': path.join(REPO, 'packages', 'client', 'schema-form', 'src', 'index.ts'),
    // The modules package's client half has no ESM-exported lib artifact (the
    // browser closure bundle registers through __ModuleLoader__); the source
    // client entry is self-contained and compiles cleanly.
    '@deepseek-ai/dsh-client-modules/client': path.join(REPO, 'packages', 'client', 'modules', 'src', 'client', 'index.ts'),
    // Node-only helpers inside vendored lib artifacts never run in the browser.
    'node:module': path.join(RENDERER, 'stubs', 'node-module.js'),
  },
  loader: {
    // CSS modules: real class maps, so component className props survive
    // (official vite handles this via its CSS pipeline).
    '.module.css': 'local-css',
    // Fonts referenced by bundled CSS (KaTeX etc.) inline as data URLs so the
    // page stays a single self-contained file.
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
  },
  define: {
    // Same three seams as official vite (vendored cordis loader probes).
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
  // The repo's tsconfig paths (source-execution convention) must NOT apply:
  // bare specifiers resolve through node_modules → package exports → built lib.
  tsconfig: path.join(RENDERER, 'tsconfig.empty.json'),
  logLevel: 'info',
})

const bundle = readFileSync(path.join(RENDERER, 'entry.bundle.js'), 'utf8')
// esbuild emits collected CSS next to the JS outfile when the graph imports it.
const cssPath = path.join(RENDERER, 'entry.bundle.css')
const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>DeepSeek Harness</title>
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>${bundle}</script>
</body>
</html>
`
writeFileSync(path.join(RENDERER, 'index.html'), html)
console.log(`[build] renderer/index.html written (css ${Math.round(css.length / 1024)}KB, js ${Math.round(bundle.length / 1024)}KB)`)
