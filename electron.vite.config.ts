import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')
/** The logo files (see resources/brand/README.md): the UI's mark and the app icon come from here. */
const brand = resolve('resources/brand')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node22',
      sourcemap: true,
      rollupOptions: {
        // Workers are loaded by path (`new Worker(join(__dirname, 'argon2.js'))`).
        input: {
          index: resolve('src/main/index.ts'),
          argon2: resolve('src/main/workers/argon2.ts'),
          filters: resolve('src/main/workers/filters.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node22',
      sourcemap: true,
      rollupOptions: {
        // index: browser UI bridge. tab: dialog bridge for web content.
        input: { index: resolve('src/preload/index.ts'), tab: resolve('src/preload/tab.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': shared,
        '@brand': brand
      }
    },
    build: { target: 'chrome130' },
    plugins: [react()]
  }
})
