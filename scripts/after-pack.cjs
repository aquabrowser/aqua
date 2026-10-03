// electron-builder afterPack hook: removes Electron's demo app (default_app.asar), which every
// Electron download carries. Aqua never loads it (the onlyLoadAppFromAsar fuse allows app.asar only).
const { rmSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  rmSync(join(resources, 'default_app.asar'), { force: true })
}
