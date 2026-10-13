import { readFileSync } from 'node:fs';
import { closeTechLead, guardTechLead } from './lib/techlead-guard.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const result = input.hook_event_name === 'Stop' ? (closeTechLead(input), null) : guardTechLead(input);
  if (result) process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`Orchestrator role guard could not inspect the action: ${error.message}`);
  process.exitCode = 2;
}
