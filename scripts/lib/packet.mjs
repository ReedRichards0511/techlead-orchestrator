const RESULT_SCHEMA = `{
  "status": "SUCCESS | PLAN_CONTRADICTION | VALIDATION_FAILURE | EXECUTION_FAILURE",
  "summary": "string",
  "modifiedFiles": [{ "path": "src/x.ts", "change": "modified|added|deleted" }],
  "planStepsCompleted": ["1", "2", "3a"],
  "validation": [{ "command": "npm run typecheck", "result": "pass|fail|skipped", "baselineFailed": false, "notes": "" }],
  "planContradiction": {
    "section": "Step 3", "planAssumption": "...", "reality": "...",
    "files": ["..."], "symbols": ["..."], "lines": ["src/a.ts:42"],
    "evidence": "...", "impact": "...", "affectedSteps": ["4", "5"],
    "changesMadeBefore": ["..."]
  },
  "errors": ["..."]
}`;

const POLICIES = {
  NO_COMMENTS_POLICY:
    'Do not add comments of any kind: no //, /* */, JSDoc, docstrings, TODO, FIXME or narrative comments. ' +
    'Do not delete existing comments just because of this rule; if your change makes one wrong, update or remove it. ' +
    'If the plan requires inline documentation, stop and report PLAN_CONTRADICTION.',
  SCOPE_POLICY:
    'Implement all of the plan and only the plan, in a single run, without asking for confirmation. ' +
    'No unrequested improvements, no refactors outside the scope, no global formatting, no extra documentation, ' +
    'and do not touch unrelated files. Do not change architecture, libraries, tooling or dependencies unless the plan says so. ' +
    '"I could improve it" is not a reason to do it.',
  CONTRADICTION_POLICY:
    'If the plan objectively contradicts the repository, STOP. Do not improvise. Write PLAN_CONTRADICTION to RESULT_PATH ' +
    'with the section, the plan assumption, the reality, files, symbols, lines, evidence, impact, affected steps and the changes already made.',
  VALIDATION_POLICY:
    'Run the commands in the plan\'s Validation section. Distinguish failures that already existed (see BASELINE) from failures you introduced.',
  GIT_POLICY:
    'Never commit, push, merge, rebase, reset --hard, clean, delete branches or touch the stash. ' +
    'Do not touch changes that are not part of this task. Never write outside WORKSPACE.',
  RUNNER_FILES_POLICY:
    'The .orchestrator/ directory is runner state and is read-only for you except writing RESULT_PATH (it is git-ignored and does not exist in CI). ' +
    'Never import, read or reference it from source code, tests, fixtures or config. If the plan says to use a file from there as a source, copy its content into the project at a tracked path inside the plan scope.',
};

function contract(config) {
  const forbidden = (config.forbiddenCommands ?? []).map((c) => `- ${c}`).join('\n');
  const body = Object.entries(POLICIES)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `${body}\nFORBIDDEN_COMMANDS:\n${forbidden}`;
}

function header(o, title) {
  return [
    `# ${title} ${o.runId}`,
    `PROJECT: ${o.project ?? 'unknown'} · ${o.stack ?? 'unknown'}`,
    `TASK: ${o.title ?? 'untitled'} · CLASS: ${o.klass}`,
    `PLAN_PATH: ${o.planPath}`,
    `WORKSPACE: ${o.workspace}`,
    `RESULT_PATH: ${o.resultPath}`,
  ].join('\n');
}

function footer() {
  return `EXPECTED_OUTPUT: write RESULT_PATH following the schema below, then stop.\n${RESULT_SCHEMA}`;
}

export function renderPacket(o) {
  return [
    header(o, 'IMPLEMENTATION PACKET'),
    `PROJECT_RULES: ${o.projectRules || '(none provided)'}`,
    `BASELINE: ${o.baseline || '(none recorded)'}`,
    'Read the plan at PLAN_PATH completely and inspect the repository before editing.',
    contract(o.config),
    footer(),
  ].join('\n\n');
}

export function renderRepairPacket(o) {
  const points = o.points
    .map((p, i) => `${i + 1}. ${p.file}${p.line ? `:${p.line}` : ''} — ${p.issue}${p.expected ? ` (expected: ${p.expected})` : ''}`)
    .join('\n');
  const commands = (o.commands ?? []).map((c) => `- ${c}`).join('\n');
  return [
    header(o, `REPAIR PACKET (cycle ${o.cycle ?? 1})`),
    'Fix only the points below. Do not redo the plan and do not change anything else.',
    `FAILED_POINTS:\n${points}`,
    `COMMANDS_THAT_MUST_PASS:\n${commands || '- (see the plan Validation section)'}`,
    `PROJECT_RULES: ${o.projectRules || '(none provided)'}`,
    `BASELINE: ${o.baseline || '(none recorded)'}`,
    contract(o.config),
    footer(),
  ].join('\n\n');
}

export function renderContinuationPacket(o) {
  const list = (xs) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  return [
    header(o, 'CONTINUATION PACKET'),
    'A previous run was interrupted. Do not restart the implementation: inspect the working tree and continue where it stopped.',
    `DONE:\n${list(o.done)}`,
    `MISSING:\n${list(o.missing)}`,
    `CHANGED_FILES:\n${list(o.changedFiles)}`,
    `TESTS_PASSED:\n${list(o.testsPassed)}`,
    `TESTS_FAILED:\n${list(o.testsFailed)}`,
    `RESUME_AT: ${o.resumeAt ?? '(see MISSING)'}`,
    `PROJECT_RULES: ${o.projectRules || '(none provided)'}`,
    `BASELINE: ${o.baseline || '(none recorded)'}`,
    contract(o.config),
    footer(),
  ].join('\n\n');
}
