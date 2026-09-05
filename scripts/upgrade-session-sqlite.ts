/** Offline, explicit-output SQLite session upgrade; the live source is never replaced. */
import { parseArgs } from 'node:util'
import { upgradeSessionDatabase } from '../packages/session/session-persistence-sqlite/src/upgrade.ts'

const { values } = parseArgs({ options: {
  source: { type: 'string' }, output: { type: 'string' }, 'confirm-stopped-and-backed-up': { type: 'boolean' },
} })
if (!values.source || !values.output || !values['confirm-stopped-and-backed-up']) {
  throw new Error('Required: --source <absolute> --output <new absolute> --confirm-stopped-and-backed-up')
}
console.log(JSON.stringify(await upgradeSessionDatabase(values.source, values.output), null, 2))
