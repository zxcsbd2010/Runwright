import ts from 'typescript'
import { defineConfig } from 'tsdown'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

const decorators = {
  name: 'runwright-standard-decorators',
  transform(code: string, id: string) {
    if (!/\.[cm]?tsx?$/.test(id) || !decoratorSyntax.test(code)) return
    const result = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        jsx: id.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
      },
    })
    return { code: result.outputText }
  },
}

const shared = {
  outDir: 'lib',
  fixedExtension: false,
  target: 'es2024',
  dts: { eager: true },
  plugins: [decorators],
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'ws', 'react', 'react-dom', 'zod'],
  },
} as const

export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts', 'src/typert.ts', 'src/remote.ts'],
    format: 'esm',
    platform: 'node',
  },
  {
    ...shared,
    entry: ['src/client.ts'],
    format: 'cjs',
    platform: 'browser',
    outputOptions(options) {
      options.entryFileNames = '[name].js'
      return options
    },
    plugins: [decorators, {
      name: 'runwright-next-module-loader',
      renderChunk(code, chunk) {
        if (chunk.fileName !== 'client.js') return
        return {
          code: `window.__ModuleLoader__.load({\n  id: "@runwright/next-adapter",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${code}\n    return module.exports;\n  }\n})`,
          map: null,
        }
      },
    }],
  },
])
