import { TYPERT_REMOTE } from './remote.js'

export const TYPERT = {
  package: '@runwright/next-adapter',
  face: 'host',
  schemas: [],
  invocations: TYPERT_REMOTE.descriptors,
} as const

export default TYPERT
