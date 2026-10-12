import { slugFor } from '../catalog.mjs';

const BLOCK = /rejected a tool call that requires confirmation/i;

export function build({ entry, effort, packetPath, repo, config, permission }) {
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
    ],
    stdinPath: null,
    cwd: repo,
    permission: mode,
  };
}

export function parse({ stdout = '', stderr = '' }) {
  return { blocked: BLOCK.test(stderr), text: stdout.trim() };
}
