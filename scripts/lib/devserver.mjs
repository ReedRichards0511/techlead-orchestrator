import { existsSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

export const DEFAULT_DEV_PORTS = [3000, 3001, 4200, 5173, 8080, 8081, 19000, 19006];
const BUILD = /(^|[\s:/\\])build(\s|$)/i;

function probe(port, { host = '127.0.0.1', timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function detectDevServers({ ports = DEFAULT_DEV_PORTS, host, timeoutMs } = {}) {
  const results = await Promise.all(ports.map(async (p) => ((await probe(p, { host, timeoutMs })) ? p : null)));
  return results.filter((p) => p !== null).sort((a, b) => a - b);
}

const BUILD_DIRS = ['.next', '.nuxt', '.svelte-kit', '.output', '.angular', '.turbo', 'dist', 'build', 'out'];

const newer = (path, sinceMs) => {
  try {
    return statSync(path).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
};

export function detectBuildArtifacts(repo, sinceMs) {
  const found = [];
  for (const name of BUILD_DIRS) {
    const dir = join(repo, name);
    if (!existsSync(dir)) continue;
    let touched = newer(dir, sinceMs);
    if (!touched) {
      try {
        touched = readdirSync(dir).some((child) => newer(join(dir, child), sinceMs));
      } catch {
        touched = false;
      }
    }
    if (touched) found.push(name);
  }
  try {
    for (const f of readdirSync(repo)) if (f.endsWith('.tsbuildinfo') && newer(join(repo, f), sinceMs)) found.push(f);
  } catch {
    return found;
  }
  return found;
}

export function buildRisk(commands = []) {
  return commands.some((c) => BUILD.test(c));
}

export function devServerAdvice({ openPorts, commands = [], packageJson = null }) {
  if (!openPorts?.length) return null;
  const risky = buildRisk(commands);
  const label = openPorts.map((p) => `:${p}`).join(', ');
  const usesNext = Boolean(packageJson?.dependencies?.next || packageJson?.devDependencies?.next);
  const restoreSteps = usesNext
    ? ['delete the .next directory', 'restart `next dev`']
    : ['restart the dev server if it starts failing or serving stale output'];
  return {
    ports: openPorts,
    buildRisk: risky,
    warning: risky
      ? `A dev server is listening on ${label} and the validation runs a build, which can overwrite the output the dev server uses. Tell Reed and include the restore steps in the final summary.`
      : null,
    restoreSteps,
  };
}
