import { resolve } from 'node:path';
import { option } from '../decide.mjs';
import { applyFileOperation } from '../file-operations.mjs';

export async function main(args) {
  const result = applyFileOperation({ repo: resolve(option(args, '--repo') ?? process.cwd()), runId: option(args, '--run'), operation: Number(option(args, '--operation')) });
  console.log(JSON.stringify(result));
  return 0;
}
