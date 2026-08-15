// One-shot icon generator: resize the user-supplied logo into tray/window sizes.
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SRC = 'C:/Users/Canpu/.zcode/cli/image-cache/sess_c31d262c-8532-4c00-94b7-e10e24646ed3/image-bb48bec43e7e5be26c793d6ff22c9def.png'

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(SRC)
  console.log('source size:', JSON.stringify(img.getSize()), 'empty:', img.isEmpty())
  if (img.isEmpty()) {
    console.error('SOURCE IMAGE EMPTY — check the path')
    app.exit(1)
    return
  }
  for (const [name, size] of [['tray.png', 32], ['icon.png', 256]]) {
    const r = img.resize({ width: size, height: size, quality: 'best' })
    fs.writeFileSync(path.join(__dirname, 'assets', name), r.toPNG())
    console.log(name, 'written:', JSON.stringify(r.getSize()))
  }
  app.exit(0)
})
