import ts from './apps/core/node_modules/typescript/lib/typescript.js'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

export default {
  plugins: [{
    name: 'runwright-standard-decorators',
    enforce: 'pre',
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return { code: result.outputText, map: result.sourceMapText }
    },
  }],
  test: {
    include: ['tests/integration/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
  },
}
