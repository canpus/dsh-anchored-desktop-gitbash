// Boots the DeepSeek Harness host tree inside the Electron main process.
// Composition: dsh-base bundle patch + desktop host patch (+ telemetry opt-out
// switch), over an empty root config. Plugin rows resolve against the repo
// through boot()'s bareModuleBaseUrl — the official "the host owns the
// complete plugin set" seat. No HTTP server, no child process, no ports.
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { provideDesktopDirectoryPicker } from './desktop-picker.mjs'

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * @param {object} options
 * @param {string} options.repo - absolute path to the deepseek-harness checkout
 * @param {NodeJS.ProcessEnv} [options.env] - launch environment (defaults to process.env)
 * @returns {Promise<{ ctx: unknown, handler: { fetch: typeof fetch } }>}
 */
export async function bootHarness({ repo, env = process.env }) {
  const appBoot = await import(pathToFileURL(path.join(repo, 'packages', 'boot', 'app-boot', 'lib', 'index.js')).href)
  const apiproxy = await import(pathToFileURL(path.join(repo, 'packages', 'host', 'apiproxy', 'lib', 'index.js')).href)
  const connection = await import(pathToFileURL(path.join(repo, 'packages', 'client', 'connection', 'lib', 'index.js')).href)
  const cmdline = await import(pathToFileURL(path.join(repo, 'packages', 'boot', 'cmdline', 'lib', 'index.js')).href)
  const launchEnv = await import(pathToFileURL(path.join(repo, 'packages', 'util', 'launch-environment', 'lib', 'index.js')).href)
  const homePaths = await import(pathToFileURL(path.join(repo, 'packages', 'util', 'home-paths', 'lib', 'index.js')).href)

  // Same heal the CLI runs on every boot: BFS the app's dependency graph and
  // symlink the flat closure into $DSH_HOME/profiles/node_modules, so bare
  // plugin row names resolve through the profile tree's module fallback.
  const installAnchor = path.join(repo, 'apps', 'cli', 'package.json')
  const dshHome = homePaths.resolveDshHome()
  appBoot.healProfilesModuleFallback(installAnchor, dshHome)

  // The vendored Loader's default internal resolver needs the
  // node-addon-require-builtin native module, which Electron's Node build
  // cannot load. Provide the same import seam ourselves: resolve bare row
  // names through the healed closure, then dynamic-import the file URL.
  const profilesRequire = createRequire(path.join(dshHome, 'profiles', '_anchor.js'))
  const moduleResolver = {
    async import(specifier) {
      const resolved = profilesRequire.resolve(specifier)
      return import(pathToFileURL(resolved).href)
    },
  }

  const basePatch = path.join(repo, 'packages', 'bundle', 'base', 'cordis.patch.yml')
  const desktopPatch = path.join(HOST_DIR, 'desktop-host-patch.yml')
  const basePatches = appBoot.loadOptionalPatches('dsh-desktop', basePatch) ?? []
  const desktopPatches = appBoot.loadOptionalPatches('dsh-desktop', desktopPatch) ?? []
  const patches = [...basePatches, ...desktopPatches]
  // Privacy switch, same semantics as the CLI: ANY non-empty value disables.
  if ((env.DSH_TELEMETRY_DISABLED ?? '') !== '') {
    patches.push({ id: 'session-telemetry-otel', disabled: true })
  }

  // The root config anchors the tree's baseUrl: plugins that resolve package
  // specs at runtime (typert-loader among them) createRequire from the
  // config-tree anchor. A desktop-own directory would miss every package
  // under pnpm isolation, so anchor beside the healed flat closure like the
  // official profiles do ($DSH_HOME/profiles/node_modules). The root is
  // rewritten on every boot: the Loader's write-back can bake composed rows
  // into it, which would duplicate every patch insert on the next boot.
  const rootConfigDir = path.join(dshHome, 'profiles', 'desktop')
  mkdirSync(rootConfigDir, { recursive: true })
  const rootConfig = path.join(rootConfigDir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  const environment = appBoot.loadLayeredEnv('dsh')

  const ctx = await appBoot.boot(
    'dsh-desktop',
    rootConfig,
    patches,
    (hostCtx) => {
      // Before any config-tree entry mounts, so plugins resolve launch-time
      // environment values from the same immutable provenance snapshot.
      hostCtx.provide(launchEnv.DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      cmdline.provideCmdline(hostCtx, { args: [], exit: () => {} })
      // Replace the addon-dependent module resolver (see above).
      hostCtx.loader.internal = moduleResolver
      // Desktop-own directory picker (Electron dialog): the apiproxy entry
      // injects this service at assembly time, so it must exist before any
      // tree entry mounts.
      provideDesktopDirectoryPicker(hostCtx)
      // Zero-port connection service: the typert-gateway entry registers its
      // /api remote interceptor through ctx.inject(['connection']) while the
      // tree assembles, so the service must exist before any entry mounts
      // (the web composition gets it from the client-connection row; desktop
      // skips the webserver row that row's registration path would need).
      new connection.HostConnectionService(hostCtx, [])
    },
    // Plugin rows resolve through the healed flat closure under
    // $DSH_HOME/profiles/node_modules (see healProfilesModuleFallback above).
    pathToFileURL(path.join(dshHome, 'profiles', '_desktop_anchor')).href,
  )

  await appBoot.assertEntriesActivated(ctx, 'dsh-desktop')

  const api = ctx.get('apiProxy')
  if (api === undefined) throw new Error('desktop host: apiProxy service missing after boot')

  // Zero-port equivalent of the official web routing: the web composition
  // mounts client-connection's host half, whose shared /api handler consults
  // the Typert remote interceptor (pluginInventory.list, commands, goals…)
  // before falling back to the apiproxy's static unary table. Desktop skips
  // the webserver row but keeps the same dispatch (the connection service
  // itself is provided in the boot prepare step above).
  const connectionService = ctx.get('connection')
  const fallback = apiproxy.toFetchHandler(api)
  const handler = connectionService.createSharedFetchHandler('/api', fallback)
  if (env.DSH_DESKTOP_DRIVE || env.DSH_HOST_DEBUG) {
    console.log('[desktop] /api interceptor registered:', connectionService.interceptors?.has('/api') ?? 'n/a')
    const matches = connectionService.interceptors?.get('/api')?.matches
    if (matches) console.log('[desktop] interceptor matches pluginInventory.list:', matches('pluginInventory.list'))
  }
  return { ctx, handler }
}
