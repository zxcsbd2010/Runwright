import { readFileSync } from 'node:fs'
import type { RuntimeHello } from '@runwright/contracts'

export const requiredRuntimeCapabilities = [
  'session.start',
  'session.attach',
  'session.cancel',
  'approval.forward',
  'validation.summary',
] as const

export interface PackageManifest {
  name?: string
  version: string
}

export interface RuntimeHelloInput {
  adapterManifest: PackageManifest
  nextManifest: PackageManifest
  dshManifest: PackageManifest
  runtimeId: string
  capabilities: readonly string[]
}

export function readPackageManifest(path: string | URL): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || !('version' in value)
    || typeof value.version !== 'string' || !value.version) {
    throw new Error('INVALID_PACKAGE_MANIFEST')
  }
  return {
    ...('name' in value && typeof value.name === 'string' ? { name: value.name } : {}),
    version: value.version,
  }
}

export function createRuntimeHello(input: RuntimeHelloInput): RuntimeHello {
  return {
    protocolMajor: 1,
    adapterVersion: input.adapterManifest.version,
    runtimeId: input.runtimeId,
    runtimeKind: 'next',
    dshVersion: input.dshManifest.version,
    nextVersion: input.nextManifest.version,
    capabilities: [...input.capabilities],
  }
}

export function assertRuntimeCapabilities(hello: RuntimeHello): void {
  if (!requiredRuntimeCapabilities.every((capability) => hello.capabilities.includes(capability))) {
    throw new Error('CAPABILITIES_UNAVAILABLE')
  }
}
