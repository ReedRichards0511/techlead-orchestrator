import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildRisk, detectDevServers, devServerAdvice } from '../lib/devserver.mjs';

function listen() {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.end());
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function freePort() {
  const { srv, port } = await listen();
  await new Promise((r) => srv.close(r));
  return port;
}

test('detectDevServers returns only the ports that accept a connection', async () => {
  const a = await listen();
  const closed = await freePort();
  try {
    const open = await detectDevServers({ ports: [closed, a.port] });
    assert.deepEqual(open, [a.port]);
  } finally {
    a.srv.close();
  }
});

test('detectDevServers handles an empty list and keeps ports sorted', async () => {
  assert.deepEqual(await detectDevServers({ ports: [] }), []);
  const a = await listen();
  const b = await listen();
  try {
    const open = await detectDevServers({ ports: [Math.max(a.port, b.port), Math.min(a.port, b.port)] });
    assert.deepEqual(open, [Math.min(a.port, b.port), Math.max(a.port, b.port)]);
  } finally {
    a.srv.close();
    b.srv.close();
  }
});

test('buildRisk is true for build commands and false for tests and linters', () => {
  assert.equal(buildRisk(['npm run build']), true);
  assert.equal(buildRisk(['npx next build', 'npm test']), true);
  assert.equal(buildRisk(['pnpm build']), true);
  assert.equal(buildRisk(['npm run lint', 'npx vitest run', 'npx tsc --noEmit']), false);
  assert.equal(buildRisk(['npm run rebuild-docs']), false);
  assert.equal(buildRisk([]), false);
});

test('devServerAdvice is null without open ports', () => {
  assert.equal(devServerAdvice({ openPorts: [], commands: ['npm run build'], packageJson: null }), null);
});

test('devServerAdvice warns about a build only when the validation includes one', () => {
  const quiet = devServerAdvice({ openPorts: [3000], commands: ['npm test'], packageJson: {} });
  assert.deepEqual(quiet.ports, [3000]);
  assert.equal(quiet.buildRisk, false);
  assert.equal(quiet.warning, null);
  const risky = devServerAdvice({ openPorts: [3000], commands: ['npm run build'], packageJson: {} });
  assert.equal(risky.buildRisk, true);
  assert.match(risky.warning, /3000/);
  assert.match(risky.warning, /build/i);
});

test('devServerAdvice gives the .next steps for a Next.js project and generic ones otherwise', () => {
  const next = devServerAdvice({ openPorts: [3000], commands: ['npm run build'], packageJson: { dependencies: { next: '15.0.0' } } });
  assert.ok(next.restoreSteps.some((s) => /\.next/.test(s)));
  assert.ok(next.restoreSteps.some((s) => /restart/i.test(s)));
  const devDep = devServerAdvice({ openPorts: [3000], commands: ['npm run build'], packageJson: { devDependencies: { next: '15.0.0' } } });
  assert.ok(devDep.restoreSteps.some((s) => /\.next/.test(s)));
  const other = devServerAdvice({ openPorts: [5173], commands: ['npm run build'], packageJson: { dependencies: { vite: '6.0.0' } } });
  assert.ok(!other.restoreSteps.some((s) => /\.next/.test(s)));
  assert.ok(other.restoreSteps.some((s) => /restart/i.test(s)));
});
