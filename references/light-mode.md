# Modo ligero

Un subagente cuesta una sesión nueva (unos 80K tokens de arranque) y un traspaso. En una tarea pequeña esa ceremonia cuesta más que la tarea. Decide en el paso 6 de `SKILL.md`, con los umbrales de `orch architect --json → lightMode` (editables en `~/.claude/orchestrator/config.json`; `lightMode.enabled: false` lo desactiva).

## Aplica solo si se cumple todo

- La clase está en `lightMode.classes` (por defecto SMALL_FIX, BUG_SIMPLE, TEST_GENERATION y MECHANICAL_CHANGE) y el cambio está entendido tras leer unos 5 archivos.
- `lightMode.maxFiles` archivos o menos (por defecto 5), sin `## File operations` ni manifests/lockfiles.
- Sin datos persistentes, seguridad, contratos compartidos ni concurrencia.
- Sin referencia visual, o con un solo nodo de Figma (un `get_design_context` tuyo, sin el lector Haiku).

## Qué cambia

- **Plan ligero** (`plan-template.md`) en lugar de la plantilla completa. `check-plan`, la pregunta del paso 8 y la medición de tokens no cambian: la elección del worker sigue siendo de Reed.
- **Cero subagentes.** Sin lector de Figma y sin auditor.
- **Reglas del proyecto mínimas:** lee `.orchestrator/project-context.md` si existe; si no, solo `CLAUDE.md`/`AGENTS.md` y un extracto de pocas líneas para `--project-rules`. No crees el contexto desde cero.
- **Auditoría en línea:** con `POSTFLIGHT OK`, empieza por `git diff --stat` y revisa tú el diff y cada paso del plan. Escribe un `audit.md` breve: veredicto, pasos verificados y postflight. Sin QA en el navegador, salvo que el plan pida comparar un texto.
- **`project-context.md`** solo se actualiza si la tarea agregó algo estructural (ruta, componente o token).

## Sube al flujo completo

En cuanto pase cualquiera de estas cosas se lanza el auditor del paso 11 (el mismo run, sin reiniciar nada): `POSTFLIGHT NOT OK`, regresiones, más de `maxFiles` archivos o `maxChangedLines` líneas cambiadas, archivos fuera del Scope, o un PLAN_CONTRADICTION que obligue a replanificar.
