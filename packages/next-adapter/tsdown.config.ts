import ts from 'typescript'
import { defineConfig } from 'tsdown'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts', 'src/typert.ts', 'src/remote.ts'],
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: { eager: true },
  plugins: [{
    name: 'runwright-standard-decorators',
    transform(code, id) {
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
  }],
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'ws', 'react', 'react-dom', 'zod'],
  },
})
