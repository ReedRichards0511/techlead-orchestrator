# Postflight, auditoría y recuperación

Qué verifica el runner solo, qué debes verificar tú y qué hacer ante una violación. Léelo en los pasos 12 a 14 del flujo.

## Contenido

1. Postflight determinista
2. Auditoría de Opus
3. Veredicto y `audit.md`
4. Repair
5. Recuperación

## 1. Postflight determinista

`orch postflight <runId> --json` escribe `runs/<runId>/postflight.json` y sale con código 1 si algo no está OK.

| Código | Severidad | Qué significa | Qué haces |
|---|---|---|---|
| HEAD_MOVED | grave | hay un commit nuevo | STOP. Muestra a Reed el comando de recuperación; no ejecutes nada |
| BRANCH_CHANGED | grave | cambió la rama | ídem |
| STASH_CHANGED | grave | cambió la lista de stash | ídem |
| DELETED_OUT_OF_PLAN | grave | borró archivos que el plan no preveía | ídem |
| MANIFEST_CHANGED | violación | cambió un manifest o lockfile sin pedirlo el plan | Revierte el cambio vía repair o pregunta a Reed |
| ORCHESTRATOR_REFERENCE | violación | una línea añadida menciona `.orchestrator/` (código, tests, fixtures o config; se excluyen `.gitignore` y similares) | Pide repair: el contenido debe vivir en una ruta versionada dentro del scope. Pasaría en local y fallaría en CI |
| OUT_OF_SCOPE | aviso | tocó archivos fuera de "In scope" | Decide en la auditoría: ¿necesario o scope creep? |
| NEW_COMMENT | aviso | comentarios o TODO nuevos en líneas `+` | Revisa cada uno; puede ser un falso positivo (por ejemplo `//` dentro de un string) |
| WHITESPACE_ONLY | aviso | reformateo masivo de espacios | Si no está en el plan, pide repair |

`ok` exige: ninguna grave o violación **y** ninguna regresión de validación. Un aviso no falla solo; se decide en la auditoría.

La re-validación se compara con el baseline del preflight y separa: **regresiones** (pasaba y ahora falla), **preexistentes** (ya fallaba) y **fixed** (fallaba y ahora pasa). Solo las regresiones cuentan contra el worker.

Los archivos nuevos escritos fuera del repo no se detectan: es un riesgo residual aceptado. Si el plan tocaba algo con rutas absolutas, revísalo a mano.

## 2. Auditoría de Opus

No confíes en el `summary` del worker. Revisa:

1. `git status` y `git diff` frente al snapshot. Archivos modificados completos cuando el diff no baste.
2. **Cada paso del plan**: ¿está implementado, con los nombres y patrones indicados? Cruza con `planStepsCompleted`, pero verifica en el código.
3. Los hallazgos del postflight (sección 1), uno por uno.
4. La re-validación: ¿regresiones? ¿alguna validación marcada `skipped` que debería haber corrido?
5. Reglas del proyecto (`PROJECT_RULES`): estilo, patrones, tests exigidos.
6. Que no haya trabajo extra: abstracciones no pedidas, dependencias, docs.
7. Si el worker reportó PLAN_CONTRADICTION, que sea real y no una excusa para evitar un paso difícil.

Lee el diff por partes si es grande: tu cuota de Claude es el recurso más escaso del sistema.

## 3. Veredicto y `audit.md`

- **PASS:** todos los pasos, sin regresiones, hallazgos resueltos o justificados.
- **REPAIR_REQUIRED:** lo que falta o sobra, con evidencia por punto.

Guarda `runs/<runId>/audit.md`:

```markdown
# Audit <runId>
Verdict: PASS | REPAIR_REQUIRED
Worker: <harness> / <modelo> / <effort>   Cycle: <n>
Plan steps: <n>/<total> verificados
Postflight: <códigos y qué decidiste de cada uno>
Validation: <regresiones | preexistentes | fixed>
Points: (solo en REPAIR_REQUIRED)
1. <archivo>:<línea> — <qué falta o sobra> (esperado: <...>)
```

## 4. Repair

- Solo los puntos fallidos, cada uno con archivo, línea y qué falta o sobra; más los comandos que tienen que pasar. Sin rehacer el plan.
- Va al **mismo worker** (harness, modelo y effort): `orch run ... --model <id> --effort <e> --repair puntos.json` (formato en SKILL.md).
- Máximo **2 ciclos**. Tras eso, detente y presenta a Reed el estado y las opciones; no abras un tercero por tu cuenta.
- Cada repair vuelve a pasar por postflight y auditoría.

## 5. Recuperación

Nunca hagas nada automático y destructivo. Ante una violación grave:

1. Muestra a Reed lo que pasó (código, archivos, hash del snapshot de `snapshots/<id>.json`).
2. El postflight imprime los comandos de recuperación según la violación: `git log --oneline <head>..HEAD` y `git reset --soft <head>` para commits nuevos, `git switch <rama>` para un cambio de rama, `git stash list` y `git stash pop` para un stash ajeno, `git checkout <commit> -- "<archivo>"` para un borrado. **Cópialos tal cual** y explícale qué hace cada uno; `reset --soft` conserva los cambios, pero aun así es decisión de Reed.
3. Ejecuta algo solo si Reed lo pide explícitamente, uno por uno.
4. El respaldo (`git stash create`) cubre solo archivos trackeados; los untracked previos quedan registrados por hash, no respaldados.

Al cerrar, `orch unlock --yes` libera el lock. Si el lock quedó huérfano por un crash, `orch unlock` te dice quién lo tiene y si el worker sigue vivo; con un worker vivo no se libera sin `--force`, que solo usa Reed.
