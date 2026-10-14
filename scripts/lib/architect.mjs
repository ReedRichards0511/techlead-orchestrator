export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALIASES = ['opus', 'sonnet', 'haiku'];
const FULL_ID = /^claude-[a-z0-9.-]+$/;

function clean(value) {
  const v = String(value ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  return v && !v.includes('${') ? v : null;
}

export function validModel(value) {
  const v = clean(value);
  return Boolean(v) && (ALIASES.includes(v) || FULL_ID.test(v));
}

export function modelMatches(configured, session) {
  const want = clean(configured);
  const have = clean(session)?.replace(/\s+/g, '-');
  if (!want || !have) return null;
  if (ALIASES.includes(want)) return have.includes(want);
  return have === want || have.startsWith(`${want}-`);
}

export function validateArchitectSettings({ model, effort, auditor } = {}) {
  if (model !== undefined && !validModel(model)) return `Invalid model "${model}": use opus, sonnet, haiku or a full claude-* id`;
  if (effort !== undefined && !EFFORTS.includes(effort)) return `Invalid effort "${effort}": use ${EFFORTS.join(', ')}`;
  if (auditor !== undefined && auditor !== 'inherit' && !validModel(auditor)) return `Invalid auditor "${auditor}": use inherit, opus, sonnet, haiku or a full claude-* id`;
  return null;
}

export function architectReport(config, session = {}) {
  const architect = config.architect;
  const model = clean(session.model);
  const effort = clean(session.effort);
  const modelOk = modelMatches(architect.model, model);
  const effortOk = effort ? effort === architect.effort : null;
  const fix = [];
  if (modelOk === false) fix.push(`/model ${architect.model}`);
  if (effortOk === false) fix.push(`/effort ${architect.effort}`);
  const known = modelOk !== null || effortOk !== null;
  const status = !known ? 'UNKNOWN' : fix.length ? 'MISMATCH' : 'OK';
  return {
    architect: { model: architect.model, effort: architect.effort, enforce: Boolean(architect.enforce) },
    auditor: { model: config.subagents.auditor.model },
    figmaReader: { model: config.subagents.figmaReader.model },
    lightMode: config.lightMode,
    session: known ? { model, effort } : null,
    status,
    fix,
    blocking: Boolean(architect.enforce) && status === 'MISMATCH',
  };
}

export function formatArchitect(r) {
  const lines = [
    `Architect:    ${r.architect.model} @ ${r.architect.effort} (enforce: ${r.architect.enforce ? 'on' : 'off'})`,
    `Session:      ${r.session ? `${r.session.model ?? '?'} @ ${r.session.effort ?? '?'}` : 'unknown'} -> ${r.status}`,
  ];
  if (r.fix.length) lines.push(`Fix:          ${r.fix.join('  ')}`);
  lines.push(
    `Auditor:      ${r.auditor.model}`,
    `Figma reader: ${r.figmaReader.model}`,
    r.lightMode.enabled
      ? `Light mode:   on (${r.lightMode.classes.join(', ')}; <= ${r.lightMode.maxFiles} files, <= ${r.lightMode.maxChangedLines} lines)`
      : 'Light mode:   off',
  );
  return lines.join('\n');
}
