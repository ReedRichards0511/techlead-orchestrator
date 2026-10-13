# Contrato del worker, packet y estados

Qué recibe y qué debe devolver un worker, y cómo se clasifican los resultados. Léelo cuando interpretes un `result.json`, un estado o un fallo.

## Contenido

1. Contrato (va en todos los packets)
2. Packet
3. `result.json`
4. Estados y fallback
5. Antes o durante el trabajo
6. Layout de una corrida

## 1. Contrato

Lo renderiza el runner; tú no lo escribes. Resumen para que sepas qué esperar del worker:

1. Lee completo el plan en `PLAN_PATH` e inspecciona el repo antes de editar.
2. Implementa **todo** el plan y **solo** el plan, en una ejecución, sin pedir confirmación.
3. No rediseña ni cambia arquitectura, librerías, tooling ni dependencias (salvo que el plan lo diga).
4. **NO_COMMENTS:** ningún comentario nuevo (`//`, `/* */`, JSDoc, docstrings, TODO, FIXME). No borra comentarios existentes por esta regla, salvo que su cambio los deje incorrectos. Si el plan exige documentación inline, se detiene con PLAN_CONTRADICTION.
5. **SCOPE:** sin mejoras no pedidas, refactors fuera del scope, formateo global ni archivos no relacionados.
6. **CONTRADICTION:** si el plan contradice objetivamente al repo, se detiene y escribe `PLAN_CONTRADICTION` con toda la evidencia.
7. **VALIDATION:** corre los comandos de "Validation" y distingue fallas preexistentes (baseline del packet) de las que introdujo.
8. **GIT:** sin commit, push, merge, rebase, `reset --hard`, `clean`, borrar branches ni tocar el stash.
9. **RUNNER_FILES:** `.orchestrator/` es solo lectura para el worker, salvo escribir `RESULT_PATH`: nunca lo importa, lee ni referencia desde código, tests, fixtures o config (git lo ignora y no existe en CI). Si el plan usa un archivo de ahí como fuente, el worker copia su contenido a una ruta versionada dentro del scope. El postflight marca `ORCHESTRATOR_REFERENCE` si una línea añadida lo menciona.
10. **FORBIDDEN_COMMANDS:** la lista de `config.json`.
11. Trabaja solo dentro de `WORKSPACE`.
12. Al terminar o detenerse escribe `RESULT_PATH` con el schema de abajo. Es obligatorio.
13. **DESIGN_CONTEXT:** si el plan aporta una referencia visual externa, usa el contexto y los assets locales ya preparados. Solo consulta esa referencia por MCP si el plan te lo asigna; si faltan detalles necesarios de la referencia, informa PLAN_CONTRADICTION antes de editar. Sin referencia externa, sigue los patrones del repo: no requiere Figma ni MCP.

El packet está en inglés porque es un prompt para el worker; el contenido de tu plan puede estar en español.

## 2. Packet

`runs/<runId>/packet.md` lo arma `orch run`. Lleva `PROJECT`, `TASK`/`CLASS`, `PLAN_PATH`, `WORKSPACE`, `RESULT_PATH`, `PROJECT_RULES`, `BASELINE`, las políticas del contrato, `FORBIDDEN_COMMANDS` y el schema de `result.json`. El plan no se copia: solo su ruta.

Variantes (misma ruta de lanzamiento, mismas políticas):
- **Repair packet:** `--repair puntos.json` → `FAILED_POINTS` + `COMMANDS_THAT_MUST_PASS`. «Corrige solo estos puntos».
- **Continuation packet:** `--continuation estado.json` → `DONE`, `MISSING`, `CHANGED_FILES`, `TESTS_PASSED`, `TESTS_FAILED`, `RESUME_AT`. «No reinicies: continúa donde quedó».

## 3. `result.json`

```json
{
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
}
```

El runner valida el schema. Si falta o es inválido, cruza el exit code, el stdout/stderr y el diff para clasificar (UNKNOWN_FAILURE → `ask-reed` si no hay ninguna señal). Para Devin y agy, un exit 0 sin `result.json` no es éxito.

El modo `dangerous` evita solicitudes de aprobación de herramientas; no significa que falte un resultado final. El resumen solo informa "sin resultado final del worker" cuando `result.json` falta o es inválido.

## 4. Estados y fallback

| Estado | Lo determina | Señales | ¿Fallback? |
|---|---|---|---|
| SUCCESS | worker + runner | `result.json` SUCCESS y postflight OK | No: pasa a auditoría |
| PLAN_CONTRADICTION | worker | `status` + `planContradiction` | **NUNCA.** Stop y vuelve a Opus |
| VALIDATION_FAILURE | worker o runner | regresiones frente al baseline | No: repair con el mismo worker |
| EXECUTION_FAILURE | runner | exit ≠ 0, crash, sin `result.json` | Sí |
| QUOTA_EXHAUSTED | runner | patrones de cuota en stderr/`error` | Sí, y refresh de cuota |
| RATE_LIMITED | runner | 429 o patrones de rate limit | Espera corta + un reintento; luego fallback |
| MODEL_UNAVAILABLE | runner | modelo inválido o no disponible | Sí |
| PROVIDER_UNAVAILABLE | runner | red o auth caídas | Sí |
| PERMISSION_FAILURE | runner | Devin: exit 0 + stdout vacío + `rejected a tool call`; agy: `denied_actions` | Devin: `retry-allowlist` o `stop-reed` (nunca `dangerous` automático); agy: fallback |
| TIMEOUT | runner | wall-clock o idle | Sí, con continuation si hubo cambios |
| UNKNOWN_FAILURE | runner | nada de lo anterior | Pregunta a Reed |

Los patrones de cuota, rate limit y modelo de Devin son genéricos hasta capturar el primer stderr real. Si aparece uno nuevo, regístralo en `findings` para afinar `classify.mjs`.

## 5. Antes o durante el trabajo

Cada fallo de ejecución lleva una fase, según el diff frente al snapshot de la corrida:

- **BEFORE_WORK** (sin diff): fallback directo al siguiente candidato (`--exclude`).
- **DURING_WORK** (con diff): inspecciona `git status`, el diff y `result.json` (si existe) y arma un **continuation packet** con lo hecho, lo que falta, tests que pasaron y fallaron, y dónde continuar. Nunca reinicies a ciegas.

## 6. Layout de una corrida

`<repo>/.orchestrator/` (se agrega a `.git/info/exclude`, no toca el `.gitignore`):

```
plans/<id>.md
lock                      un solo escritor
snapshots/<id>.json       snapshot de la tarea (HEAD, branch, stash, hashes, baseline)
runs/<runId>/
  packet.md  result.json  snapshot.json  status.json  events.jsonl
  stdout.log  stderr.log  postflight.json  audit.md
```

`status.json` se actualiza al iniciar, cada 30 s y al terminar; si deja de latir, `orch status` marca la corrida como `LOST`.
