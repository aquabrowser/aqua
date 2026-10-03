import type { AquaApi } from '../shared/api'

declare global {
  interface Window {
    readonly aqua: AquaApi
  }
}

export {}
