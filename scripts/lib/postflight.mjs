import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './config.mjs';
import { getStatus } from './run.mjs';
import { postflightChecks } from './safety.mjs';
import { compareToBaseline, parsePlanValidation, runValidation } from './validate.mjs';

const ENDED = new Set(['exited', 'timeout', 'error']);

export async function runPostflight({ repo, runId, config, skipValidate = false }) {
  const st = getStatus({ repo, runId });
  if (!st) throw new Error(`Unknown run: ${runId}`);
  if (!ENDED.has(st.state)) throw new Error(`Run ${runId} is still running (state: ${st.state})`);

  const planPath = st.meta?.planPath;
  const planId = st.meta?.planId;
  if (!planPath || !existsSync(planPath)) throw new Error(`Plan file for run ${runId} not found: ${planPath ?? 'unknown'}`);
  const snapshot = readJson(join(repo, '.orchestrator', 'snapshots', `${planId}.json`), null);
  if (!snapshot) throw new Error(`No snapshot for plan ${planId}. Run: orch preflight --plan ${planPath}`);

  const planText = readFileSync(planPath, 'utf8');
  const checks = postflightChecks({ repo, snapshot, planText, config });

  let validation = { skipped: true, baseline: snapshot.baseline ?? [], current: [], regressions: [], preexisting: [], fixed: [] };
  if (!skipValidate) {
    const commands = parsePlanValidation(planText);
    const current = await runValidation({
      repo,
      commands,
      forbidden: config.forbiddenCommands ?? [],
      timeoutMs: (config.safety?.validationTimeoutSeconds ?? 600) * 1000,
    });
    validation = { skipped: false, baseline: snapshot.baseline ?? [], current, ...compareToBaseline(snapshot.baseline ?? [], current) };
  }

  const violations = [...checks.violations];
  const cls = st.classification;
  if (cls?.status !== 'SUCCESS') {
    violations.push({ code: 'RUN_NOT_SUCCESS', severity: 'violation', detail: `The run was classified ${cls?.status ?? 'unknown'} (${cls?.action ?? 'no action'}), not SUCCESS` });
  } else if (cls.noChanges || checks.changedFiles.length === 0) {
    violations.push({ code: 'EMPTY_SUCCESS', severity: 'violation', detail: 'The worker reported SUCCESS but the working tree has no changes since the snapshot' });
  }
  const blocking = violations.some((v) => v.severity === 'grave' || v.severity === 'violation');

  const result = {
    runId,
    planId,
    ok: !blocking && validation.regressions.length === 0,
    classification: st.classification,
    violations,
    changedFiles: checks.changedFiles,
    comments: checks.comments,
    recovery: checks.recovery,
    notes: checks.notes,
    validation,
  };
  writeFileSync(join(st.runDir, 'postflight.json'), JSON.stringify(result, null, 2));
  return result;
}
