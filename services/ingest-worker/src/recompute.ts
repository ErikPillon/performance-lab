/**
 * Recompute derived training metrics for an athlete.
 *
 *   npm run recompute -- --athlete "Erik"
 *   npm run recompute -- --athlete "Erik" --estimate-thresholds
 *   npm run recompute -- --athlete "Erik" --preference precision
 *
 * The dashboard can trigger the same operation; both call `recomputeAthlete`.
 */
import { closeQueues } from '@lab/jobs';
import { sql as pg } from '@lab/db';
import { findAthlete, recomputeAthlete } from './recomputeAll.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

const name = arg('--athlete') ?? 'Erik';
const preference = (arg('--preference') ?? 'consistency') as 'consistency' | 'precision';
if (!['consistency', 'precision'].includes(preference)) {
  console.error(`--preference must be "consistency" or "precision", got "${preference}"`);
  process.exit(1);
}

const target = await findAthlete(name);
if (!target) {
  console.error(`no athlete named "${name}"`);
  process.exit(1);
}
console.log(`recomputing for ${target.displayName} (${target.id})\n`);

const result = await recomputeAthlete(target.id, {
  estimateThresholds: has('--estimate-thresholds'),
  preference,
  onProgress: (u) => {
    if (u.phase === 'thresholds') console.log(`thresholds: ${u.message}`);
    else if (u.phase === 'load' && u.done !== undefined) {
      if (u.done === u.total) console.log(`load: ${u.done}/${u.total}`);
      else if (u.done % 50 === 0) console.log(`load: ${u.done}/${u.total}`);
    } else if (u.phase === 'pmc') console.log('building fitness model...');
  },
});

for (const warning of result.thresholdWarnings) console.log(`  ! ${warning}`);

console.log(`\n${result.activities} activities scored (${result.failed} failed) in ${(result.elapsedMs / 1000).toFixed(1)}s`);
console.log('\ncalibrated load-per-hour from directly measured sessions:');
for (const [sport, rate] of Object.entries(result.rates)) {
  console.log(`  ${sport.padEnd(10)} ${rate.toFixed(1)} load/hour`);
}
console.log(`\nwrote ${result.days} daily rows`);

await closeQueues();
await pg.end();
