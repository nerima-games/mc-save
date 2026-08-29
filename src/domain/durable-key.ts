import { SaveKey } from './save-key.js'

export const DURABLE_PREVIOUS_SUFFIX = '::previous'

export const durablePreviousKey = (key: SaveKey): SaveKey => SaveKey(`${key}${DURABLE_PREVIOUS_SUFFIX}`)

export const isDurablePreviousKey = (key: SaveKey): boolean => key.endsWith(DURABLE_PREVIOUS_SUFFIX)
