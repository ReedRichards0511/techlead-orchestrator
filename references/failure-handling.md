# Estados de `orch go`, fallos, repair y continuation

Léelo cuando `orch go` termine en un estado distinto de SUCCESS, o cuando haya que lanzar un repair o una continuation. SUCCESS y VALIDATION_FAILURE van directo al auditor (paso 11 de `SKILL.md`).

## Qué hacer según la clasificación

`orch status` y `orch wait` devuelven `classification.status` y `classification.action`. Obedece la acción:

| status | action | Qué haces |
|---|---|---|
| SUCCESS | `postflight` | `orch go` ya corrió el postflight: auditoría (paso 11) |
| VALIDATION_FAILURE | `audit` | Auditoría; si hay regresiones, repair con el **mismo** worker |
| PLAN_CONTRADICTION | `stop-opus` | **Sin fallback.** Lee `result.json → planContradiction`, contrasta con el repo, corrige el plan o pregunta a Reed. Luego relanza |
| PERMISSION_FAILURE (Devin) | `retry-allowlist` | El runner leyó del export de Devin qué llamada se rechazó y el comando está en el plan y no es destructivo. Relanza con `orch go ... --allow-from <runId>` (más `--continuation` si `phase` es `DURING_WORK`): añade solo esas reglas `Exec(...)`. Nunca `dangerous` automático |
| PERMISSION_FAILURE (Devin) | `stop-reed` | Comando destructivo, fuera del plan, de git o de config global, no inspeccionable, o segundo bloqueo tras la allowlist. No escales permisos: muéstrale a Reed `blocked` (comando y motivo) y sus opciones. Si ya escribió todos los archivos del plan, `orch postflight <runId>` y el auditor |
| fallo `BEFORE_WORK` | `fallback` | Sin diff: recomienda con `orch route --class <C> --exclude <id>@<effort> --json` y repite la pregunta del paso 8 antes de lanzar otra combinación |
| fallo `DURING_WORK` | `continuation` | Hubo diff: continuation packet (abajo). No reinicies a ciegas. Si cambia la combinación, recomienda y pregunta antes de continuar |
| RATE_LIMITED | `wait-retry` | Espera brevemente y reintenta una vez con la misma combinación aprobada; después, propone alternativas y pregunta |
| QUOTA_EXHAUSTED | `fallback` | `orch quota exhausted <provider>` registra el límite observado durante 1 h (agy usa provider `antigravity`). Recomienda alternativas y pregunta; no consultes porcentajes ni cambies automáticamente de worker |
| UNKNOWN_FAILURE | `ask-reed` | Muestra el stdout/stderr relevante y pregunta |

**`dangerous` solo lo decide Reed** (el runner nunca lo reintenta solo). Si Reed lo pide y el clasificador de Claude Code lo bloquea, el bloqueo es de Claude Code porque lanza un agente sin confirmaciones. No lo esquives ni intentes otra vía. Dile a Reed qué falló y ofrécele, en este orden:
1. Aprobar ese comando en el prompt de permisos, o ejecutarlo él mismo en su terminal (dale el comando exacto).
2. Una regla `allow` en su `settings.json` para ese caso, si quiere que no vuelva a preguntar (no la edites tú).
3. Seguir sin reintento: si `git status` y el diff muestran que el worker ya escribió los archivos del plan, corre `orch postflight <runId>` y el auditor (las validaciones se vuelven a correr). Si faltan pasos del plan, no declares PASS: usa continuation con otro worker (`--exclude`) o espera la decisión de Reed.

Describe lo ocurrido: `dangerous` significa "sin solicitudes de aprobación de herramientas". Solo di "sin resultado final del worker" si falta `result.json` o es inválido; si existe y es válido, informa su estado y el veredicto de tu auditoría.

Los estados completos y sus fases están en `worker-contract.md`.

## Repair y continuation

Ambos se lanzan con `orch go` en background (sin repetir el preflight) y llevan el contrato completo; no escribas el packet a mano.

- **Repair:** `orch go --plan <ruta> --class <C> --model <id> --effort <e> --repair puntos.json`, con la **misma combinación aprobada**, salvo nueva elección explícita de Reed. `puntos.json`: `{"cycle":1,"points":[{"file":"src/a.ts","line":42,"issue":"...","expected":"..."}],"commands":["npm test"]}`. Solo los puntos fallidos, con evidencia; no rehagas el plan. Luego continúa el **mismo** auditor con `SendMessage` y la nueva salida (en modo ligero, audita tú).
- **Continuation:** `--continuation estado.json` con `{"done":[...],"missing":[...],"changedFiles":[...],"testsPassed":[...],"testsFailed":[...],"resumeAt":"paso 4"}`. Sácalo de `git status`, el diff y `result.json`.
- Máximo 2 ciclos de repair (el runner rechaza el tercero). Tras 2 sin PASS, detente y presenta a Reed el estado y las opciones.
