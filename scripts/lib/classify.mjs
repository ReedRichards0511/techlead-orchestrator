import { assessBlockedCalls } from './permissions.mjs';

const RESULT_STATUSES = ['SUCCESS', 'PLAN_CONTRADICTION', 'VALIDATION_FAILURE', 'EXECUTION_FAILURE'];
const CHANGES = ['modified', 'added', 'deleted'];
const VALIDATION_RESULTS = ['pass', 'fail', 'skipped'];
const CONTRADICTION_FIELDS = ['section', 'planAssumption', 'reality', 'evidence'];

export function validateResult(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['result is not an object'] };
  if (!RESULT_STATUSES.includes(r.status)) errors.push(`status must be one of ${RESULT_STATUSES.join(', ')}`);
  if (typeof r.summary !== 'string') errors.push('summary must be a string');
  if (!Array.isArray(r.modifiedFiles)) errors.push('modifiedFiles must be an array');
  else {
    for (const f of r.modifiedFiles) {
      if (typeof f?.path !== 'string' || !CHANGES.includes(f.change)) errors.push(`invalid modifiedFiles entry: ${JSON.stringify(f)}`);
    }
  }
  if (!Array.isArray(r.planStepsCompleted)) errors.push('planStepsCompleted must be an array');
  if (!Array.isArray(r.validation)) errors.push('validation must be an array');
  else {
    for (const v of r.validation) {
      if (typeof v?.command !== 'string' || !VALIDATION_RESULTS.includes(v.result)) errors.push(`invalid validation entry: ${JSON.stringify(v)}`);
    }
  }
  if (r.errors !== undefined && !Array.isArray(r.errors)) errors.push('errors must be an array');
  if (r.status === 'PLAN_CONTRADICTION') {
    const pc = r.planContradiction;
    if (!pc || typeof pc !== 'object') errors.push('planContradiction is required for PLAN_CONTRADICTION');
    else for (const k of CONTRADICTION_FIELDS) if (typeof pc[k] !== 'string' || !pc[k]) errors.push(`planContradiction.${k} is required`);
  }
  return { ok: errors.length === 0, errors };
}

const RATE = /\b429\b|rate.?limit|too many requests/i;
const QUOTA = /quota|usage limit|limit reached|credits? (?:exhausted|depleted)|exceeded your/i;
const MODEL = /invalid model|unknown model|model .*(?:not found|unavailable|not available|does not exist)|no such model/i;
const PROVIDER = /ENOTFOUND|ECONN(?:RESET|REFUSED)|ETIMEDOUT|network error|not logged in|unauthorized|authentication|\b401\b|\b403\b/i;

function phaseOf(diffEmpty) {
  if (diffEmpty === true) return 'BEFORE_WORK';
  if (diffEmpty === false) return 'DURING_WORK';
  return 'UNKNOWN';
}

function failover(status, input, extra = {}) {
  const phase = phaseOf(input.diffEmpty);
  return {
    status,
    phase,
    fallback: true,
    action: phase === 'BEFORE_WORK' ? 'fallback' : 'continuation',
    ...extra,
  };
}

function errorText(input) {
  const parts = [];
  const p = input.parsed ?? {};
  if (Array.isArray(p.errors)) parts.push(...p.errors);
  if (p.error) parts.push(p.error);
  if (input.exitCode !== 0 && input.exitCode !== undefined) parts.push(input.stderr ?? '');
  return parts.join('\n');
}

function permissionDenied(input) {
  const p = input.parsed ?? {};
  if (input.harness === 'devin') return Boolean(p.blocked);
  if (input.harness === 'agy') return (p.deniedActions ?? []).length > 0;
  return false;
}

function permissionFailure(input) {
  const phase = phaseOf(input.diffEmpty);
  if (input.harness !== 'devin') {
    return { ...failover('PERMISSION_FAILURE', input), detail: 'Antigravity denied actions in headless mode' };
  }
  const a = assessBlockedCalls({
    calls: input.parsed.blockedCalls ?? [],
    planText: input.planText ?? '',
    forbidden: input.forbidden ?? [],
    repo: input.repo ?? '',
    allowedFileCommands: input.allowedFileCommands ?? [],
  });
  const retry = a.safe && !input.allowlistRetry && input.permission !== 'dangerous';
  let why = `Devin rejected a tool call: ${a.reason}`;
  if (retry) why = `Devin rejected tool calls that the plan names: ${a.allowExec.join(', ')}`;
  else if (a.safe) why = 'Devin rejected tool calls again after an allowlist retry';
  return {
    status: 'PERMISSION_FAILURE',
    phase,
    fallback: false,
    action: retry ? 'retry-allowlist' : 'stop-reed',
    allowExec: retry ? a.allowExec : [],
    blocked: a.calls,
    detail: why,
  };
}

export function classifyRun(input) {
  const { state, harness, result, resultInvalid, parsed = {} } = input;
  const detail = (d) => ({ detail: d });

  if (result?.status === 'PLAN_CONTRADICTION') {
    return { status: 'PLAN_CONTRADICTION', phase: null, fallback: false, action: 'stop-opus', ...detail('worker reported a plan contradiction') };
  }

  if (state === 'timeout') return { ...failover('TIMEOUT', input), ...detail('wall-clock or idle timeout') };
  if (state === 'error') return { ...failover('EXECUTION_FAILURE', input), ...detail('worker could not be spawned') };

  if (result && result.status !== 'PLAN_CONTRADICTION' && permissionDenied(input) && ['SUCCESS', 'VALIDATION_FAILURE'].includes(result.status)) {
    return permissionFailure(input);
  }

  if (result) {
    switch (result.status) {
      case 'SUCCESS':
        if (input.exitCode !== 0) {
          return { ...failover('EXECUTION_FAILURE', input), ...detail(`worker reported SUCCESS but exited with code ${input.exitCode ?? 'unknown'}`) };
        }
        if (harness === 'codex' && parsed.sawEvents && !parsed.completed) {
          return { ...failover('EXECUTION_FAILURE', input), ...detail('codex reported SUCCESS but its run never completed') };
        }
        return {
          status: 'SUCCESS',
          phase: null,
          fallback: false,
          action: 'postflight',
          ...(input.diffEmpty === true ? { noChanges: true } : {}),
          ...detail('result.json reports SUCCESS'),
        };
      case 'VALIDATION_FAILURE':
        return { status: 'VALIDATION_FAILURE', phase: null, fallback: false, action: 'audit', ...detail('validation regressions reported') };
      default:
        return { ...failover('EXECUTION_FAILURE', input), ...detail('worker reported an execution failure') };
    }
  }

  const text = errorText(input);
  if (RATE.test(text)) {
    const retry = (input.rateRetries ?? 0) < 1;
    return { ...failover('RATE_LIMITED', input), ...(retry ? { action: 'wait-retry' } : {}), ...detail('rate limited') };
  }
  if (QUOTA.test(text)) return { ...failover('QUOTA_EXHAUSTED', input), refreshQuota: true, ...detail('quota exhausted') };
  if (MODEL.test(text)) return { ...failover('MODEL_UNAVAILABLE', input), ...detail('model unavailable') };
  if (PROVIDER.test(text)) return { ...failover('PROVIDER_UNAVAILABLE', input), ...detail('provider unreachable or unauthenticated') };

  if (permissionDenied(input)) return permissionFailure(input);

  if (input.exitCode !== 0 && input.exitCode !== undefined && input.exitCode !== null) {
    return { ...failover('EXECUTION_FAILURE', input), ...detail(`exit code ${input.exitCode} and no valid result.json`) };
  }

  return {
    status: 'UNKNOWN_FAILURE',
    phase: phaseOf(input.diffEmpty),
    fallback: false,
    action: 'ask-reed',
    ...detail(resultInvalid ? 'result.json is present but invalid' : 'no result.json and no known failure signal'),
  };
}
