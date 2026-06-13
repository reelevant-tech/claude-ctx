import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..', 'src')

const FORBIDDEN_BARE = ['web-tree-sitter', '@huggingface/transformers', 'typescript']
const FORBIDDEN_PATH = ['/core/embed/', '/core/ast/']

function resolveTs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand)) return cand
  }
  return null
}

/** Transitive relative-import cone of an entry file. */
function importCone(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>()
  const bare = new Set<string>()
  const stack = [entry]
  while (stack.length) {
    const f = stack.pop()!
    if (files.has(f)) continue
    files.add(f)
    const src = readFileSync(f, 'utf8')
    const re = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const spec = m[1] ?? m[2]!
      if (spec.startsWith('.')) {
        const r = resolveTs(f, spec)
        if (r) stack.push(r)
      } else {
        bare.add(spec)
      }
    }
  }
  return { files, bare }
}

describe('hook hot-path purity', () => {
  it('the hook entry import cone never reaches embed/ast or heavy libs', () => {
    const { files, bare } = importCone(join(SRC, 'bin', 'hook.ts'))
    const heavyFiles = [...files].filter((f) => FORBIDDEN_PATH.some((p) => f.includes(p)))
    const heavyBare = [...bare].filter((b) => FORBIDDEN_BARE.includes(b))
    expect(heavyFiles).toEqual([])
    expect(heavyBare).toEqual([])
  })

  it('the built hook bundle (if present) contains no heavy library code', () => {
    const bundle = join(SRC, '..', 'dist', 'hook.cjs')
    if (!existsSync(bundle)) return // build not run; the esbuild guard covers this at build time
    const code = readFileSync(bundle, 'utf8')
    // transformers.js + tree-sitter ship unmistakable runtime tokens
    expect(code.includes('@huggingface/transformers')).toBe(false)
    expect(code.includes('onnxruntime')).toBe(false)
    expect(code.toLowerCase().includes('emscripten')).toBe(false)
  })
})
