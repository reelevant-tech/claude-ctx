import { describe, expect, it } from 'vitest'
import { mapTests } from '../../src/core/indexer/tests'
import type { FileRecord, PackageInfo } from '../../src/core/types'

const fr = (over: Partial<FileRecord> = {}): FileRecord => ({
  h: 'abcdef123456',
  mtime: 0,
  size: 10,
  lines: 1,
  lang: 'ts',
  pkg: -1,
  parser: 'none',
  kind: 'source',
  risk: [],
  entry: false,
  exports: [],
  externalDeps: [],
  docHeadings: [],
  tests: [],
  ...over,
})

const cargoPkg = (over: Partial<PackageInfo> = {}): PackageInfo => ({
  id: 0,
  name: 'crate',
  dir: '',
  kind: 'cargo',
  manifest: 'Cargo.toml',
  entrypoints: ['src/lib.rs'],
  ...over,
})

describe('mapTests', () => {
  it('sibling rule: foo.test.ts links to foo.ts in same dir', () => {
    const files = {
      'src/foo.ts': fr(),
      'src/foo.test.ts': fr(),
    }
    mapTests(files, [], {})
    expect(files['src/foo.test.ts'].kind).toBe('test')
    expect(files['src/foo.ts'].tests).toEqual(['src/foo.test.ts'])
    expect(files['src/foo.test.ts'].testedBy).toBe('src/foo.ts')
  })

  it('spec suffix and __tests__ dir map to parent sibling', () => {
    const files = {
      'src/bar.ts': fr(),
      'src/__tests__/bar.test.ts': fr(),
      'src/baz.ts': fr(),
      'src/baz.spec.ts': fr(),
    }
    mapTests(files, [], {})
    expect(files['src/__tests__/bar.test.ts'].kind).toBe('test')
    expect(files['src/bar.ts'].tests).toEqual(['src/__tests__/bar.test.ts'])
    expect(files['src/__tests__/bar.test.ts'].testedBy).toBe('src/bar.ts')
    expect(files['src/baz.ts'].tests).toEqual(['src/baz.spec.ts'])
  })

  it('marks ts/js files under top-level test/ and tests/ dirs', () => {
    const files = {
      'test/helpers.ts': fr(),
      'tests/e2e.py': fr({ lang: 'other' }),
      'src/app.ts': fr(),
    }
    mapTests(files, [], {})
    expect(files['test/helpers.ts'].kind).toBe('test')
    expect(files['tests/e2e.py'].kind).toBe('test') // tests/ prefix applies to any lang
    expect(files['src/app.ts'].kind).toBe('source')
  })

  it('does not reclassify non-source kinds', () => {
    const files = {
      'dist/foo.test.js': fr({ kind: 'generated', lang: 'js' }),
    }
    mapTests(files, [], {})
    expect(files['dist/foo.test.js'].kind).toBe('generated')
  })

  it('graph rule: imported sources gain the test, first sorted import wins testedBy', () => {
    const files = {
      'test/integration.test.ts': fr(),
      'src/b.ts': fr(),
      'src/a.ts': fr(),
      'src/cfg.ts': fr({ kind: 'config' }),
    }
    const fwd = { 'test/integration.test.ts': ['src/b.ts', 'src/a.ts', 'src/cfg.ts'] }
    mapTests(files, [], fwd)
    expect(files['src/a.ts'].tests).toEqual(['test/integration.test.ts'])
    expect(files['src/b.ts'].tests).toEqual(['test/integration.test.ts'])
    expect(files['src/cfg.ts'].tests).toEqual([]) // kind config excluded
    expect(files['test/integration.test.ts'].testedBy).toBe('src/a.ts')
  })

  it('sibling testedBy is not overwritten by graph rule', () => {
    const files = {
      'src/foo.ts': fr(),
      'src/aaa.ts': fr(),
      'src/foo.test.ts': fr(),
    }
    mapTests(files, [], { 'src/foo.test.ts': ['src/aaa.ts', 'src/foo.ts'] })
    expect(files['src/foo.test.ts'].testedBy).toBe('src/foo.ts')
    expect(files['src/aaa.ts'].tests).toEqual(['src/foo.test.ts'])
  })

  it('rust: tests/*.rs map to the package src/lib.rs', () => {
    const files = {
      'src/lib.rs': fr({ lang: 'rust', parser: 'rust' }),
      'tests/integration.rs': fr({ lang: 'rust', parser: 'rust' }),
      'tests/common/mod.rs': fr({ lang: 'rust', parser: 'rust' }),
    }
    mapTests(files, [cargoPkg()], {})
    expect(files['tests/integration.rs'].kind).toBe('test')
    // only direct children of tests/ are cargo test targets
    expect(files['src/lib.rs'].tests).toEqual(['tests/integration.rs'])
  })

  it('rust: nested package dir is respected', () => {
    const files = {
      'crates/a/src/lib.rs': fr({ lang: 'rust' }),
      'crates/a/tests/it.rs': fr({ lang: 'rust' }),
      'tests/other.rs': fr({ lang: 'rust' }),
    }
    mapTests(files, [cargoPkg({ dir: 'crates/a', manifest: 'crates/a/Cargo.toml' })], {})
    expect(files['crates/a/src/lib.rs'].tests).toEqual(['crates/a/tests/it.rs'])
  })

  it('dedupes and sorts tests[] including pre-seeded entries', () => {
    const files = {
      'src/lib.rs': fr({ lang: 'rust', tests: ['tests/zz.rs', 'src/lib.rs'] }),
      'tests/zz.rs': fr({ lang: 'rust' }),
      'tests/aa.rs': fr({ lang: 'rust' }),
    }
    mapTests(files, [cargoPkg()], {})
    expect(files['src/lib.rs'].tests).toEqual(['src/lib.rs', 'tests/aa.rs', 'tests/zz.rs'])
  })
})
