import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Runwright bundle manifest', () => {
  it('declares a patch that inserts the adapter plugin', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
      name: string
      files?: string[]
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.files).toEqual(['lib', 'cordis.patch.yml'])
    expect(manifest.dependencies).not.toHaveProperty('@runwright/contracts')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(readFileSync(`${root}/${manifest.dsh!.bundle!.patch!}`, 'utf8').trim()).toBe(`- insert:\n    - id: runwright-next-adapter\n      name: '${manifest.name}'`)
  })
})
