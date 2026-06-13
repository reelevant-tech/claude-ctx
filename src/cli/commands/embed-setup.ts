import { setupEmbeddings } from '../../installer/embed-runtime'
import { parseCommon } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { 'skip-install': { type: 'boolean' } })
  return setupEmbeddings({ repo: a.repo, skipInstall: a.values['skip-install'] === true })
}
