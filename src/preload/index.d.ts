import type { MikroApi } from '../shared/types'

declare global {
  interface Window {
    api: MikroApi
  }
}
