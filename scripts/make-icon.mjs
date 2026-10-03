// Renders the brand mark (resources/brand/logo.svg, plus logo-small.svg for small sizes when it
// exists) with Electron's own Chromium and writes the app icons:
//   build/icon.ico  every Windows size: the .exe, taskbar, Alt+Tab, Start menu, installer
//   build/icon.png  1024 px: electron-builder makes the macOS .icns (Dock) and Linux icons from it
// Run after replacing the logo: npm run icon
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRAND = join(root, 'resources', 'brand')
// Chromium's working files go to a temporary folder, not %APPDATA%. It is still in use when
// this process quits, so each run removes the ones earlier runs left behind.
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith('aqua-icon-')) rmSync(join(tmpdir(), name), { recursive: true, force: true })
}
app.setPath('userData', mkdtempSync(join(tmpdir(), 'aqua-icon-')))

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
/** Below this size the small variant is used, when there is one. */
const SMALL_BELOW = 48

/** Runs in the page: rasterises an SVG at `size` (vector, so crisp at every size) and returns a PNG data URL. */
async function render(size, svgBase64) {
  const img = new Image()
  img.src = `data:image/svg+xml;base64,${svgBase64}`
  await img.decode()
  const canvas = new OffscreenCanvas(size, size)
  canvas.getContext('2d').drawImage(img, 0, 0, size, size)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.readAsDataURL(blob)
  })
}

/** An .ico holding PNG pictures (supported by Windows since Vista). */
function packIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

app.whenReady().then(async () => {
  const main = readFileSync(join(BRAND, 'logo.svg')).toString('base64')
  const smallFile = join(BRAND, 'logo-small.svg')
  const small = existsSync(smallFile) ? readFileSync(smallFile).toString('base64') : main

  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await window.loadURL('data:text/html,<!doctype html><title>icon</title>')
  const png = async (size, svg) => {
    const dataUrl = await window.webContents.executeJavaScript(`(${render.toString()})(${size}, "${svg}")`)
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  }

  const images = []
  for (const size of ICO_SIZES) images.push({ size, png: await png(size, size < SMALL_BELOW ? small : main) })
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'icon.ico'), packIco(images))
  writeFileSync(join(root, 'build', 'icon.png'), await png(1024, main))
  console.log(`wrote build/icon.ico (${ICO_SIZES.join(', ')} px) and build/icon.png (1024 px)`)
  app.quit()
})
