import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('Runwright bundle manifest', () => {
  it('declares a patch that inserts the adapter plugin', () => {
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

  it('declares the typed model required by the NEXT Typert loader', async () => {
    const { TYPERT } = await import('../src/typert.js')

    expect(TYPERT.model).toEqual({ services: [], events: [], objects: [] })
  })

  it('builds the browser client for the NEXT module loader', () => {
    execFileSync('pnpm', ['build'], { cwd: root, stdio: 'pipe' })
    const client = readFileSync(`${root}/lib/client.js`, 'utf8')

    expect(client).toContain('window.__ModuleLoader__.load({')
    expect(client).toContain('id: "@runwright/next-adapter"')
    expect(client).not.toMatch(/^import\s/m)
  })
})
