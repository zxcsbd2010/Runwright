import { TYPERT_REMOTE } from './remote.js'

export const TYPERT = {
  package: '@runwright/next-adapter',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: TYPERT_REMOTE.descriptors,
} as const

export default TYPERT
