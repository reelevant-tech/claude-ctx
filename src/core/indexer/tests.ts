import type { FileRecord, PackageInfo } from '../types'

const TEST_BASENAME = /^(.+)\.(test|spec)\.([a-z]+)$/
const TEST_SUFFIX = /\.(test|spec)\.[a-z]+$/

function isTestPath(rel: string, rec: FileRecord, testDirs: string[]): boolean {
  if (TEST_SUFFIX.test(rel)) return true
  const segs = rel.split('/')
  if (segs.includes('__tests__')) return true
  if (rel.startsWith('tests/') || rel.includes('/tests/')) return true
  if (rec.lang === 'ts' || rec.lang === 'js') {
    for (const dir of testDirs) if (rel.startsWith(dir)) return true
  }
  return false
}

/**
 * Marks test files and links source <-> test, mutating records in place.
 * All tests[] arrays end up deduped and sorted (covers rust self-appended entries too).
 */
export function mapTests(
  files: Record<string, FileRecord>,
  packages: PackageInfo[],
  fwd: Record<string, string[]>,
): void {
  const paths = Object.keys(files).sort()

  // 'test/' at repo root or under a package dir
  const testDirs = ['test/']
  for (const pkg of packages) if (pkg.dir !== '') testDirs.push(`${pkg.dir}/test/`)

  for (const rel of paths) {
    const rec = files[rel]
    if (!rec) continue
    if (rec.kind !== 'source' && rec.kind !== 'test') continue
    if (isTestPath(rel, rec, testDirs)) rec.kind = 'test'
  }

  // sibling rule: foo.test.ts -> foo.ts in same dir, __tests__/foo.test.ts -> ../foo.ts
  for (const rel of paths) {
    const rec = files[rel]
    if (!rec || rec.kind !== 'test') continue
    const slash = rel.lastIndexOf('/')
    const dir = slash === -1 ? '' : rel.slice(0, slash)
    const base = slash === -1 ? rel : rel.slice(slash + 1)
    const m = TEST_BASENAME.exec(base)
    if (!m) continue
    const sib = `${m[1]}.${m[3]}`
    const candidates = [dir === '' ? sib : `${dir}/${sib}`]
    if (dir.split('/').pop() === '__tests__') {
      const parent = dir.slice(0, Math.max(0, dir.lastIndexOf('/')))
      candidates.push(parent === '' ? sib : `${parent}/${sib}`)
    }
    for (const cand of candidates) {
      const src = files[cand]
      if (!src || cand === rel || src.kind === 'test') continue
      src.tests.push(rel)
      rec.testedBy = cand
      break
    }
  }

  // graph rule: a test importing a source file covers it
  for (const rel of paths) {
    const rec = files[rel]
    if (!rec || rec.kind !== 'test') continue
    for (const target of [...(fwd[rel] ?? [])].sort()) {
      const src = files[target]
      if (!src || src.kind !== 'source') continue
      src.tests.push(rel)
      rec.testedBy ??= target
    }
  }

  // rust integration tests: <pkg>/tests/*.rs -> <pkg>/src/lib.rs
  for (const pkg of packages) {
    if (pkg.kind !== 'cargo') continue
    const prefix = pkg.dir === '' ? '' : `${pkg.dir}/`
    const lib = files[`${prefix}src/lib.rs`]
    if (!lib) continue
    const re = new RegExp(`^${escapeRe(prefix)}tests/[^/]+\\.rs$`)
    for (const rel of paths) {
      if (re.test(rel) && files[rel]?.kind === 'test') lib.tests.push(rel)
    }
  }

  for (const rel of paths) {
    const rec = files[rel]
    if (rec && rec.tests.length > 0) rec.tests = [...new Set(rec.tests)].sort()
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
