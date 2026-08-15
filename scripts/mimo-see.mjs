// Minimal MIMO vision call for shell diagnostics (perception skill flow).
// Usage: node scripts/mimo-see.mjs <image-path> [question]
// Reads the MIMO provider (name "MIMO") from ~/.zcode/v2/config.json; the key
// is never echoed.
'use strict'
import fs from 'node:fs'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('usage: node scripts/mimo-see.mjs <image-path> [question]')
  process.exit(2)
}
const question = process.argv[3]
  || '请详细描述这张图片的内容：界面布局、所有可见文字、按钮与状态、以及任何异常或问题。输出结构化观察清单。'

const cfg = JSON.parse(fs.readFileSync('C:/Users/Canpu/.zcode/v2/config.json', 'utf8'))
const mimo = Object.values(cfg.provider).find((p) => p.name === 'MIMO')
if (!mimo) {
  console.error('MIMO provider not found in config.json')
  process.exit(1)
}
const apiKey = mimo.options.apiKey
const base = String(mimo.options.baseURL || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
const lower = file.toLowerCase()
const mime = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg'
  : lower.endsWith('.webp') ? 'image/webp'
  : 'image/png'
const b64 = fs.readFileSync(file).toString('base64')

;(async () => {
  const body = JSON.stringify({
    model: 'mimo-v2.5',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        { type: 'text', text: question },
      ],
    }],
  })
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    console.error('HTTP', res.status, text.slice(0, 500))
    process.exit(1)
  }
  const data = JSON.parse(text)
  console.log(data.choices?.[0]?.message?.content ?? text.slice(0, 2000))
})().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
