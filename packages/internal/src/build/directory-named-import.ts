import path from 'node:path'

import { parseSync } from 'oxc-parser'
import type { ValueSpan } from 'oxc-parser'

import { importStatementPath, resolveFile } from '@cedarjs/project-config'

/**
 * Matches a quoted relative specifier. Files without one have nothing to
 * rewrite, so they are returned without being parsed.
 */
const RELATIVE_SPECIFIER_RE = /['"]\.\.?\//

/**
 * A relative path with at least one segment after `./` or `../`. A bare `./`
 * or `../` (e.g. what `src/` alias rewriting produces for an import of the
 * importing file's own directory) is left as it is.
 */
const RELATIVE_PATH_RE = /^\.\.?\/./

/**
 * Rewrites relative imports/re-exports of a directory to that directory's
 * index file or directory-named module, so that the esbuild API build (with
 * `bundle: false`) produces output files with resolvable import paths at
 * runtime.
 *
 * This replaces `babel-plugin-redwood-directory-named-import` for the esbuild
 * build paths. It is a plain function called inline from the existing esbuild
 * `onLoad` handlers — not an esbuild plugin itself.
 *
 * For a file importing `./Button` where `./Button/Button.tsx` exists (but
 * `./Button.*` does not), this rewrites the import to `./Button/Button`.
 * Mirrors the precedence used by `cedarDirectoryNamedImportPlugin` (Vite):
 * an index file wins over a directory-named module.
 *
 * The specifiers come from oxc-parser's module record: the source of every
 * static `import` and `export ... from` statement, with its position. Like the
 * babel plugin this replaces, it covers every import and re-export form,
 * however it is formatted or commented, and leaves dynamic `import(...)` calls
 * and import-like text in strings and comments alone. Only the module record
 * is read, not the AST, so very large generated files (e.g. Prisma's
 * `models/*.ts`) are handled without serializing their AST.
 */
export function applyDirectoryNamedImport(
  code: string,
  filePath: string,
): string {
  if (!RELATIVE_SPECIFIER_RE.test(code)) {
    return code
  }

  const { module } = parseSync(filePath, code, { sourceType: 'module' })

  // Keyed by position: every entry of `export { a, b } from './x'` shares
  // the same module request.
  const requests = new Map<number, ValueSpan>()

  for (const staticImport of module.staticImports) {
    requests.set(staticImport.moduleRequest.start, staticImport.moduleRequest)
  }

  for (const staticExport of module.staticExports) {
    for (const entry of staticExport.entries) {
      if (entry.moduleRequest) {
        requests.set(entry.moduleRequest.start, entry.moduleRequest)
      }
    }
  }

  const fileDir = path.dirname(filePath)
  let result = code

  // Splice from the end of the file backwards so earlier positions stay valid
  const byPositionDescending = [...requests.values()].sort(
    (a, b) => b.start - a.start,
  )

  for (const request of byPositionDescending) {
    const resolvedPath = resolveDirectoryImport(request.value, fileDir)

    if (resolvedPath) {
      // The request's span includes its quotes
      const quote = code[request.start]
      result =
        result.slice(0, request.start) +
        quote +
        resolvedPath +
        quote +
        result.slice(request.end)
    }
  }

  return result
}

/**
 * Returns the specifier to use for a relative import of a directory, or `null`
 * if the import needs no rewrite (it isn't relative, it already resolves to a
 * file, or it can't be resolved at all).
 */
function resolveDirectoryImport(
  importPath: string,
  fileDir: string,
): string | null {
  if (!RELATIVE_PATH_RE.test(importPath)) {
    return null
  }

  const absolutePath = path.join(fileDir, importPath)

  if (resolveFile(absolutePath)) {
    return null
  }

  if (resolveFile(path.join(absolutePath, 'index'))) {
    return importStatementPath(importPath + '/index')
  }

  const basename = path.basename(absolutePath)
  if (resolveFile(path.join(absolutePath, basename))) {
    return importStatementPath(importPath + '/' + basename)
  }

  return null
}
