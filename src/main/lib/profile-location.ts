import { join, resolve } from 'path'

/**
 * Where Aqua keeps its profile, decided once before the app is ready:
 *
 *   custom     AQUA_USER_DATA_DIR (testing, a second identity)
 *   portable   next to the program, in `AquaData`:
 *              - `single-file`: the self-extracting Aqua-Browser-Portable.exe
 *                (its launcher sets PORTABLE_EXECUTABLE_DIR to its own folder);
 *              - `folder`: the unpacked portable build, recognised by the
 *                `AquaData` folder it ships with next to Aqua Browser.exe;
 *   installed  the system's per-user application data folder.
 *
 * Pure (file checks are passed in) so it can be unit tested.
 */

export type ProfileMode = 'custom' | 'portable' | 'installed'
export type PortableKind = 'single-file' | 'folder'

export interface ProfileLocation {
  mode: ProfileMode
  portableKind: PortableKind | null
  /** The profile folder, or null to keep Electron's default (installed builds). */
  path: string | null
}

export interface LocationInputs {
  env: Record<string, string | undefined>
  /** Folder of the running executable. */
  exeDir: string
  isPackaged: boolean
  isDirectory: (path: string) => boolean
  /** Whether files can be created there (a portable copy on a read-only drive can't keep its data). */
  isWritable: (path: string) => boolean
}

export const PORTABLE_DATA_DIR = 'AquaData'

export function resolveProfileLocation(inputs: LocationInputs): ProfileLocation {
  const { env, exeDir, isPackaged, isDirectory, isWritable } = inputs
  const custom = env['AQUA_USER_DATA_DIR']
  if (custom) return { mode: 'custom', portableKind: null, path: resolve(custom) }

  const launcherDir = env['PORTABLE_EXECUTABLE_DIR']
  if (launcherDir) {
    const dir = join(launcherDir, PORTABLE_DATA_DIR)
    if (isWritable(dir)) return { mode: 'portable', portableKind: 'single-file', path: dir }
  }

  const beside = join(exeDir, PORTABLE_DATA_DIR)
  if (isPackaged && !launcherDir && isDirectory(beside) && isWritable(beside)) {
    return { mode: 'portable', portableKind: 'folder', path: beside }
  }
  return { mode: 'installed', portableKind: null, path: null }
}
