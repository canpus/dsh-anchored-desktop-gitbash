// First-launch dependency relinker for the green package.
//
// The zip ships the real pnpm virtual-store tree WITHOUT junctions (zip cannot
// store them portably); this script rebuilds every junction/symlink recorded in
// repo/link-manifest.json, using repo-relative targets resolved at runtime, so
// the layout is identical to a fresh pnpm install on this machine. Windows
// junctions need NO admin rights (unlike symlinks), so first launch works as a
// plain double-click. Fully offline — no pnpm/corepack download involved.
//
// Idempotent: a marker file (node_modules/.dsh-green-linked) skips the work;
// existing links are verified and only recreated when missing or pointing
// elsewhere (e.g. after an upstream upgrade rebuilt node_modules).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(__dirname, '..', 'repo')
const manifestPath = path.join(repo, 'link-manifest.json')
const marker = path.join(repo, 'node_modules', '.dsh-green-linked')

if (!fs.existsSync(manifestPath)) {
  console.log('[relink] no link-manifest.json (dev checkout?) — nothing to do')
  process.exit(0)
}
if (fs.existsSync(marker)) {
  console.log('[relink] already linked — skipping')
  process.exit(0)
}
if (!fs.existsSync(path.join(repo, 'node_modules', '.pnpm'))) {
  console.error('[relink] .pnpm virtual store missing — the package is incomplete')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const links = (manifest.links || []).filter((l) => typeof l.target === 'string' && !l.target.startsWith('..'))
const skippedOutside = (manifest.links || []).length - links.length
if (skippedOutside > 0) console.warn(`[relink] skipping ${skippedOutside} links whose targets point outside the repo`)

console.log(`[relink] rebuilding ${links.length} dependency links (first run only)…`)

let junctions = 0
let fileCopies = 0
let alreadyOk = 0
let failed = 0
const firstFailures = []

async function relinkOne({ link, target, kind }) {
  const linkAbs = path.join(repo, link)
  const targetAbs = path.join(repo, target)
  await fsp.mkdir(path.dirname(linkAbs), { recursive: true })
  try {
    const rp = await fsp.realpath(linkAbs)
    if (path.resolve(rp).toLowerCase() === path.resolve(targetAbs).toLowerCase()) {
      alreadyOk++
      return
    }
    // Points elsewhere (stale) — replace it.
    await fsp.rm(linkAbs, { recursive: true, force: true })
  } catch {
    // Absent — create below.
  }
  try {
    if (kind === 'file') {
      await fsp.copyFile(targetAbs, linkAbs)
      fileCopies++
    } else {
      fs.symlinkSync(targetAbs, linkAbs, 'junction')
      junctions++
    }
  } catch (error) {
    failed++
    if (firstFailures.length < 10) firstFailures.push(`${link}: ${String(error?.message || error)}`)
  }
}

const POOL = 16
let cursor = 0
async function worker() {
  while (cursor < links.length) {
    const item = links[cursor++]
    try {
      await relinkOne(item)
    } catch {
      // never let one bad entry kill the whole run
    }
    if (cursor % 20000 === 0) {
      console.log(`[relink] progress ${cursor}/${links.length} (junctions=${junctions} files=${fileCopies} ok=${alreadyOk} failed=${failed})`)
    }
  }
}

await Promise.all(Array.from({ length: POOL }, worker))
if (firstFailures.length > 0) {
  console.error('[relink] first failures:\n' + firstFailures.join('\n'))
}
fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
console.log(`[relink] done: ${junctions} junctions, ${fileCopies} file copies, ${alreadyOk} already-correct, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
