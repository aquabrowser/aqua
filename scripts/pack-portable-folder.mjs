/**
 * The portable folder build: run after `electron-builder --win dir`.
 *
 *   npm run dist:portable-folder
 *
 * Turns <output>/win-unpacked into <output>/Aqua Browser, adds the AquaData
 * folder (its presence next to Aqua Browser.exe is what makes a copy
 * portable, see src/main/lib/profile-location.ts) and zips the result.
 * Unlike the single-file Aqua-Browser-Portable.exe, nothing is unpacked when
 * it starts, so it opens as fast as an installed copy.
 *
 * The output folder defaults to electron-builder.json's; pass another as the
 * first argument (e.g. when building with -c.directories.output=dist-next).
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'electron-builder.json'), 'utf-8'))
const out = resolve(root, process.argv[2] ?? config.directories?.output ?? 'dist')
const unpacked = join(out, 'win-unpacked')
const folder = join(out, 'Aqua Browser')
const zip = join(out, 'Aqua-Browser-Portable.zip')

if (!existsSync(unpacked)) {
  console.error(`${unpacked} not found - run electron-builder --win dir first`)
  process.exit(1)
}
rmSync(folder, { recursive: true, force: true })
renameSync(unpacked, folder)
mkdirSync(join(folder, 'AquaData'), { recursive: true })
copyFileSync(join(root, 'resources', 'portable', 'README.txt'), join(folder, 'AquaData', 'README.txt'))

// Windows' own tar (bsdtar) writes zip files; the one Git Bash puts first on PATH does not.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
rmSync(zip, { force: true })
const result = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', out, 'Aqua Browser'], { stdio: 'inherit' })
if (result.status !== 0) {
  console.error('zip failed')
  process.exit(result.status ?? 1)
}
console.log(`${folder}\n${zip}`)
