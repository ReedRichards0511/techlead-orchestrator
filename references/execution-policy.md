# Ejecución y separación de roles

El Tech Lead analiza, planifica, supervisa y audita. El worker elegido realiza toda implementación: código, tests, documentación y assets, incluidos cambios mecánicos. Un bloqueo no convierte al Tech Lead en implementador; prepara una continuación o solicita la decisión que falte. El mismo worker/modelo/effort aprobado puede continuar sin otra selección.

## Protección del Tech Lead

Los hooks `PreToolUse` y `Stop` están incluidos en la skill; no se modifica settings.json. Requieren Claude Code >= 2.1.295 y Node accesible en PATH. `doctor` verifica la versión mínima. El hook funciona en macOS y Windows y se carga desde la instalación global `skills/orchestrator` bajo `CLAUDE_CONFIG_DIR` o `~/.claude`.

Desde `usage start` hasta el cierre de la respuesta, las herramientas Write/Edit/MultiEdit/NotebookEdit solo pueden escribir planes o JSON de repair/continuation dentro de `.orchestrator/plans/` y `runs/<id>/audit.md`. No pueden alterar result, status, snapshot ni contadores. Bash/PowerShell permiten lectura, comandos de validación declarados y comandos del runner; bloquean ediciones mecánicas, intérpretes ad hoc y `worker-files`. Prefiere Read/Glob/Grep para inspección. Un comando de lectura no reconocido debe sustituirse por esas herramientas, no por una vía que eluda el hook.

Los hooks permanecen registrados en la sesión de Claude, pero la restricción se activa solo para su tarea y session_id. El cierre de tokens no la desactiva prematuramente: Stop la libera después de la respuesta de cierre, para no restringir tareas ajenas posteriores. Si pausas para preguntar o esperar al worker, conserva la tarea abierta. Si abandonas la tarea, cierra sus métricas antes de responder. No deshabilites hooks ni cambies el registro para implementar tú mismo.

## Operaciones de archivos del worker

Declara únicamente operaciones necesarias, con archivos concretos relativos al workspace y dentro de In scope:

```markdown
## File operations
- Move: `src/old/Card.tsx` -> `src/components/Card.tsx`
- Delete: `src/obsolete.ts`
```

Si no hay movimientos ni eliminaciones, usa `- None` u omite la sección. No incluyas prose, carpetas, globs ni comandos shell en ella. El runner verifica fuentes existentes, destino libre, ausencia de symlinks/traversal/rutas protegidas y scope; respalda las fuentes durante el preflight. `check-plan` hace la comprobación inicial sin lock ni escrituras.

El packet entrega un comando `worker-files` exacto por operación. El worker lo ejecuta antes de modificar el destino; no improvisa git mv, rm, mv, scripts de borrado ni llamadas directas a fs para sustituirlo. El helper exige un run activo y su lock, verifica que la operación sigue declarada, conserva el respaldo y rechaza sobrescrituras. Una operación completada puede repetirse en una continuación sin volver a aplicarla.

No repitas preflight sobre ese mismo id: reemplazaría el baseline del trabajo parcial. El runner conserva sus respaldos y pide reutilizar el snapshot con una continuación; para un nuevo alcance usa un id nuevo. Out of scope prevalece sobre una carpeta amplia de In scope.

En Devin smart se agregan solo esos comandos exactos a la allowlist temporal, junto con las validaciones. No habilita Git mutante, rm general ni node arbitrario. Codex y Antigravity reciben el mismo contrato/helper. Un nuevo movimiento no previsto exige corregir el plan y preparar un nuevo preflight compatible; no cambies operaciones a mitad de una corrida. Si hay cambios parciales, conserva sus respaldos y acuerda el nuevo alcance antes de preparar otro baseline.

## Antes del primer worker

Revisa símbolos, formatos de datos y tipos contra el código y las definiciones instaladas; registra rutas/símbolos como evidencia. No deduzcas compatibilidad por el nombre del tipo ni por ejemplos con any. Contrasta cada paso con reglas del proyecto y del packet. `check-plan` detecta estructura inválida, algunas peticiones explícitas de comentarios nuevos y operaciones imposibles; las incompatibilidades semánticas siguen siendo responsabilidad del Tech Lead. Si una decisión requiere información del usuario, resuélvela antes de recomendar el worker.

## Espera y veredicto

Ejecuta `orch go ...` una vez en Bash con `run_in_background: true`: preflight solo en el primer lanzamiento del plan, run, espera y postflight en una llamada. Devuelve una única salida final o LOST; el supervisor conserva sus límites de tiempo y heartbeat. Cada turno de Opus relee todo su contexto, así que agrupar comandos y delegar la auditoría a un subagente (`references/subagents.md`) es lo que más ahorra. Espera la notificación del harness y recoge el resultado una vez. No hagas polling desde Opus ni crees timers auxiliares. Monitor es alternativa cuando exista; si no hay una espera por notificación, deja explícitamente el run pendiente hasta poder consultar su resultado.

PASS exige postflight sin hallazgos bloqueantes ni regresiones. Los avisos de scope/formato/comentarios se justifican uno por uno; un `ok: false` no se convierte en PASS por una afirmación de Opus. El historial rechaza PASS cuando el postflight guardado falla. Repairs y cambios de producto corresponden al worker.

Documentación oficial: [hooks de skills y su duración](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents), [ejecución de hooks sin shell](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form), [Bash en segundo plano](https://code.claude.com/docs/en/interactive-mode#background-bash-commands).
