import { readFileSync } from 'node:fs';
import { supervise } from './proc.mjs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
await supervise(spec);
process.exit(0);
