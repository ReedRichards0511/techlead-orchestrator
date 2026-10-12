import { readFileSync } from 'node:fs';
import { restoreDevinAllowlist } from './devin-allow.mjs';
import { supervise } from './proc.mjs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
await supervise(spec);
if (spec.cleanup?.kind === 'devin-allow') {
  try {
    restoreDevinAllowlist({ repo: spec.cleanup.repo, runDir: spec.cleanup.runDir });
  } catch (e) {
    process.stderr.write(`could not restore the Devin allowlist: ${e.message}
`);
  }
}
process.exit(0);
