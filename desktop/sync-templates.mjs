// Sync bundled preset templates from the third-party research mirrors into
// desktop/presets/ and (re)write each template's .manifest.json — upstream
// commits + per-file sha256. Run after pulling third-party/:
//   node desktop/sync-templates.mjs
//
// Copy lists and adapters come from component-defs.cjs (the same definitions
// the runtime component updater uses) so the two paths can never drift.
// Templates ship verbatim (搬运机器); installers verify copied files against
// the manifest hashes before any local adaptation — a partial copy or a stale
// bundled version fails loud instead of mounting a half-preset (D77 lesson).
// Dev-only: stripped from the green package.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import defs from './component-defs.cjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = __dirname
const THIRD = path.resolve(DESKTOP, '..', 'third-party')

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const gitHead = (repoDir) => execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

// Mirror layout per component (third-party/<mirror>/...).
const MIRROR = {
  'anchored-standard': path.join(THIRD, 'dsh-anchored-standard'),
  'router-standard': path.join(THIRD, 'dsh-routing-suite', 'preset'), // the suite's preset SUBMODULE checkout
  'minimal-gitbash': path.join(THIRD, 'dsh-gitbash-preset'),
}

function syncPreset(id) {
  const comp = defs.COMPONENTS[id]
  if (!comp) throw new Error('unknown component: ' + id)
  const mirror = MIRROR[id]
  const to = path.join(DESKTOP, 'presets', id)
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(to, { recursive: true })
  const files = {}
  const entries = comp.submodule ? comp.submodule.files : comp.files
  for (const { src, name } of entries) {
    const from = path.join(mirror, src)
    if (!fs.existsSync(from)) throw new Error(`missing upstream file: ${src}`)
    fs.copyFileSync(from, path.join(to, name))
    files[name] = sha256(from)
  }
  const manifest = {
    upstream: comp.repo,
    ...(comp.submodule
      ? { suiteCommit: gitHead(path.join(THIRD, 'dsh-routing-suite')), presetCommit: gitHead(mirror) }
      : { commit: gitHead(mirror) }),
    note: comp.manifestNote,
    adaptedFields: comp.adapter === 'anchored-bashPath' ? ['agent.cordis.yml:bashPath']
      : comp.adapter === 'gitbash-shellPath' ? ['agent.cordis.yml:shellPath']
      : [],
    files,
  }
  fs.writeFileSync(path.join(to, '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`synced ${path.relative(DESKTOP, to)}: ${entries.length} files`)
}

for (const id of Object.keys(defs.COMPONENTS)) {
  syncPreset(id)
}
