import { join } from 'node:path';
import { slugFor } from '../catalog.mjs';
import { parseDevinExport } from '../permissions.mjs';

const BLOCK = /rejected a tool call that requires confirmation/i;

export const EXPORT_NAME = 'devin-session.json';

export function build({ entry, effort, packetPath, repo, config, permission, runDir }) {
  const mode = permission ?? config.permissions?.devin?.default ?? 'smart';
  return {
    exeName: 'devin',
    args: [
      '-p',
      '--prompt-file',
      packetPath,
      '--model',
      slugFor(entry, effort),
      '--respect-workspace-trust',
      'false',
      '--permission-mode',
      mode,
      ...(runDir ? ['--export', join(runDir, EXPORT_NAME)] : []),
    ],
    stdinPath: null,
    cwd: repo,
    permission: mode,
  };
}

export function parse({ stdout = '', stderr = '', runDir }) {
  const session = runDir ? parseDevinExport(join(runDir, EXPORT_NAME)) : { rejected: [] };
  const blocked = BLOCK.test(stderr) || session.rejected.length > 0;
  return { blocked, blockedCalls: session.rejected, text: stdout.trim() };
}
