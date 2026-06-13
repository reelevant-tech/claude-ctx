import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIX = join(__dirname, '..', 'fixtures')

/**
 * Copy a fixture into a temp dir OUTSIDE the repo and `git init` it, so it
 * behaves like a standalone repo: findRepoRoot stops at it, and scanRepo uses
 * the git enumeration path. Fixtures live inside this repo, so without this
 * they'd resolve up to the claude-ctx root.
 */
export function gitFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ctx-fix-${name}-`))
  cpSync(join(FIX, name), dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
  return dir
}
