// Minimal ZIP writer + reader (pure Node, zero deps) — the packaging pipeline
// uses this instead of the System32 bsdtar because that build stores non-ASCII
// entry names in the ANSI codepage (GBK on Chinese Windows) with the UTF-8
// flag UNSET: 用户指南.md lands as GBK bytes and extracts as mojibake on every
// machine (v0.3.8 builds 1–2, D68), and its --hdrcharset option is not
// compiled in (tested: "not supported"; LC_ALL=C.UTF-8 also ignored).
// Names here are ALWAYS stored as UTF-8 with the language-encoding flag
// (bit 11) set — portable on every OS.
// Per the environment skill rule: 中文文件名批量操作走脚本，不经控制台代码页工具。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

function dosTime(ms) {
  const d = new Date(ms)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

// Write <rootDir> as a zip at <zipPath> with every entry prefixed "<prefix>/".
// Streams to disk (local headers + data first, central directory + EOCD last);
// returns the number of entries written. Deflate level 6, stored only when
// deflate does not shrink. The staging tree has 81k+ entries, so a ZIP64 EOCD
// record + locator are written when the classic 16-bit entry-count field would
// overflow (0xFFFF), per the ZIP spec. Per-entry ZIP64 extra fields are NOT
// emitted — fail fast if the archive ever approaches 4GB (local-header offsets
// are 32-bit).
export function writeZip(rootDir, zipPath, prefix) {
  const entries = []
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      let st
      try { st = fs.lstatSync(p) } catch { continue }
      if (st.isDirectory()) {
        entries.push({ rel: r + '/', dir: true, mtimeMs: st.mtimeMs })
        walk(p, r)
      } else if (st.isFile()) {
        entries.push({ rel: r, dir: false, mtimeMs: st.mtimeMs, full: p })
      }
      // junctions/symlinks never appear in the staging tree — they are
      // recorded in link-manifest.json and rebuilt by relink.mjs.
    }
  }
  walk(rootDir, '')

  const fd = fs.openSync(zipPath, 'w')
  try {
    let offset = 0
    const put = (b) => { fs.writeSync(fd, b, 0, b.length); offset += b.length }
    const central = []
    const localHeader = (nameB, method, crc, csize, usize, t) => {
      const h = Buffer.alloc(30)
      h.writeUInt32LE(0x04034b50, 0)
      h.writeUInt16LE(20, 4)        // version needed: 2.0
      h.writeUInt16LE(0x800, 6)     // general purpose flag: UTF-8 names
      h.writeUInt16LE(method, 8)
      h.writeUInt16LE(t.time, 10)
      h.writeUInt16LE(t.date, 12)
      h.writeUInt32LE(crc, 14)
      h.writeUInt32LE(csize, 18)
      h.writeUInt32LE(usize, 22)
      h.writeUInt16LE(nameB.length, 26)
      h.writeUInt16LE(0, 28)        // extra field length
      return h
    }

    for (const e of entries) {
      const nameB = Buffer.from(`${prefix}/${e.rel}`, 'utf8')
      const t = dosTime(e.mtimeMs)
      let method = 0
      let crc = 0
      let csize = 0
      let usize = 0
      let data = Buffer.alloc(0)
      if (!e.dir) {
        const raw = fs.readFileSync(e.full)
        // Always attempt deflate: native binaries compress ~2x too (measured:
        // electron.exe 215MB -> 94MB at level 6 in ~5s). A size-based store
        // shortcut was tried first and it doubled the package (1176MB vs
        // 640MB, v0.3.8 build 4) — store only when deflate does not shrink.
        const def = zlib.deflateRawSync(raw, { level: 6 })
        crc = zlib.crc32(raw) >>> 0
        usize = raw.length
        if (def.length < raw.length) { method = 8; csize = def.length; data = def } else { method = 0; csize = raw.length; data = raw }
      }
      const localOff = offset
      put(localHeader(nameB, method, crc, csize, usize, t))
      put(nameB)
      put(data)
      central.push({ nameB, method, crc, csize, usize, t, localOff })
    }

    const cdStart = offset
    for (const c of central) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(20, 4)        // version made by: 2.0
      h.writeUInt16LE(20, 6)        // version needed
      h.writeUInt16LE(0x800, 8)     // UTF-8 names
      h.writeUInt16LE(c.method, 10)
      h.writeUInt16LE(c.t.time, 12)
      h.writeUInt16LE(c.t.date, 14)
      h.writeUInt32LE(c.crc, 16)
      h.writeUInt32LE(c.csize, 20)
      h.writeUInt32LE(c.usize, 24)
      h.writeUInt16LE(c.nameB.length, 28)
      h.writeUInt16LE(0, 30)        // extra
      h.writeUInt16LE(0, 32)        // comment
      h.writeUInt16LE(0, 34)        // disk start
      h.writeUInt16LE(0, 36)        // internal attrs
      h.writeUInt32LE(0, 38)        // external attrs
      h.writeUInt32LE(c.localOff, 42)
      put(Buffer.concat([h, c.nameB]))
    }
    const cdSize = offset - cdStart
    if (cdStart >= 0xfffffffe) throw new Error('archive approaches 4GB — per-entry ZIP64 extra fields not implemented')
    // ZIP64: classic EOCD entry-count is 16-bit. With 81k+ staged entries the
    // real counts go into a ZIP64 EOCD record (+ locator) and the classic
    // fields are saturated at 0xFFFF per spec (a hard crash here burned a full
    // 10-minute zip write once — count is checked via needZip64, not assumed).
    const needZip64 = central.length >= 0xffff || cdSize >= 0xffffffff || cdStart >= 0xffffffff
    if (needZip64) {
      const z = Buffer.alloc(56)
      z.writeUInt32LE(0x06064b50, 0)
      z.writeBigUInt64LE(44n, 4)   // size of the rest of this record
      z.writeUInt16LE(45, 12)      // version made by: 4.5
      z.writeUInt16LE(45, 14)      // version needed
      z.writeUInt32LE(0, 16)       // this disk
      z.writeUInt32LE(0, 20)       // disk with CD start
      z.writeBigUInt64LE(BigInt(central.length), 24)
      z.writeBigUInt64LE(BigInt(central.length), 32)
      z.writeBigUInt64LE(BigInt(cdSize), 40)
      z.writeBigUInt64LE(BigInt(cdStart), 48)
      put(z)
      const loc = Buffer.alloc(20)
      loc.writeUInt32LE(0x07064b50, 0)
      loc.writeUInt32LE(0, 4)      // disk with the zip64 EOCD
      loc.writeBigUInt64LE(BigInt(offset) - 56n, 8)
      loc.writeUInt32LE(1, 16)     // total disks
      put(loc)
    }
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)        // disk number
    eocd.writeUInt16LE(0, 6)        // central directory start disk
    eocd.writeUInt16LE(needZip64 ? 0xffff : central.length, 8)
    eocd.writeUInt16LE(needZip64 ? 0xffff : central.length, 10)
    eocd.writeUInt32LE(cdSize >= 0xffffffff ? 0xffffffff : cdSize, 12)
    eocd.writeUInt32LE(cdStart >= 0xffffffff ? 0xffffffff : cdStart, 16)
    eocd.writeUInt16LE(0, 20)       // comment length
    put(eocd)
    return central.length
  } finally {
    fs.closeSync(fd)
  }
}

// Flag-aware reader used by pack-green.mjs to verify what was written: parses
// the central directory directly (which itself asserts ZIP structure — a tar
// renamed .zip cannot fake an EOCD, D61) and decodes names per the UTF-8 flag,
// with zero codepage conversion involved.
export function listZipNames(zipPath) {
  const fd = fs.openSync(zipPath, 'r')
  try {
    const st = fs.fstatSync(fd)
    const tailLen = Math.min(65557, st.size)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen)
    let i = -1
    for (let j = tailLen - 22; j >= 0; j--) {
      if (tail[j] === 0x50 && tail[j + 1] === 0x4b && tail[j + 2] === 0x05 && tail[j + 3] === 0x06) { i = j; break }
    }
    if (i < 0) throw new Error('EOCD not found — archive is not a zip')
    const e = tail.subarray(i, i + 22)
    let entTotal = e.readUInt16LE(10)
    let cdSize = e.readUInt32LE(12)
    let cdOff = e.readUInt32LE(16)
    if (entTotal === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      // ZIP64: the locator sits in the 20 bytes right before the classic EOCD
      // and points at the ZIP64 EOCD record holding the real 64-bit values.
      if (i < 20) throw new Error('zip64 archive but locator truncated')
      const loc = tail.subarray(i - 20, i)
      if (loc.readUInt32LE(0) !== 0x07064b50) throw new Error('zip64 archive but locator missing')
      const z64Off = Number(loc.readBigUInt64LE(8))
      const z = Buffer.alloc(56)
      fs.readSync(fd, z, 0, 56, z64Off)
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 EOCD record missing')
      entTotal = Number(z.readBigUInt64LE(32))
      cdSize = Number(z.readBigUInt64LE(40))
      cdOff = Number(z.readBigUInt64LE(48))
    }
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOff)
    const names = []
    let off = 0
    while (off + 46 <= cd.length) {
      if (cd.readUInt32LE(off) !== 0x02014b50) break
      const flags = cd.readUInt16LE(off + 8)
      const nameLen = cd.readUInt16LE(off + 28)
      const extraLen = cd.readUInt16LE(off + 30)
      const commentLen = cd.readUInt16LE(off + 32)
      const nameBuf = cd.subarray(off + 46, off + 46 + nameLen)
      names.push((flags & 0x800) ? nameBuf.toString('utf8') : nameBuf.toString('latin1'))
      off += 46 + nameLen + extraLen + commentLen
    }
    if (names.length !== entTotal) throw new Error(`central directory incomplete (${names.length}/${entTotal} entries)`)
    return names
  } finally {
    fs.closeSync(fd)
  }
}
