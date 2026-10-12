# Política de routing

Qué contiene: cómo clasificar una tarea, qué candidatos tiene cada clase, qué es un tier y cómo el router llega a la ROUTING DECISION. Léelo en los pasos 6 y 8 del flujo, o cuando una decisión te sorprenda.

## Contenido

1. Cómo elegir la clase
2. Candidatos por clase
3. Tiers
4. Algoritmo
5. Bootstrap
6. Leer y corregir la decisión

## 1. Cómo elegir la clase

Elige la clase por **lo que exige razonar**, no por el tamaño del diff. Si dudas entre dos, sube a la mayor: un worker débil en una tarea difícil cuesta más repairs que un worker fuerte en una fácil.

| Clase | Cuándo | Minutos estimados | Timeout (wall) |
|---|---|---|---|
| SMALL_FIX | 1–3 archivos, cambio puntual | 15 | 20 |
| BUG_SIMPLE | Causa conocida, fix localizado | 20 | 25 |
| MECHANICAL_CHANGE | Renombres, patrón repetido, muchos archivos | 30 | 40 |
| TEST_GENERATION | Tests sobre código existente | 30 | 40 |
| REFACTOR | Reestructurar sin cambiar comportamiento | 45 | 60 |
| MIGRATION | Versiones, APIs, esquemas | 60 | 90 |
| FEATURE | Funcionalidad nueva con plan muy detallado | 60 | 75 |
| CROSS_LAYER_FEATURE | Frontend, backend y datos, con razonamiento residual | 75 | 90 |
| BUG_COMPLEX | Causa incierta, varias capas | 60 | 75 |
| NATIVE_MOBILE | Android/iOS, Gradle, Xcode, módulos nativos de RN | 75 | 90 |
| ARCHITECTURAL_IMPL | Implementa una arquitectura nueva que definiste tú | 90 | 120 |

Los minutos estimados deciden si un reset de cuota llega "antes de que termine la tarea". Los timeouts salen de `config.json → timeouts` (más `idleMinutes: 15`).

## 2. Candidatos por clase

Orden de preferencia por calidad. ⇄ participa del bootstrap (sección 5).

| Clase | 1ª | 2ª | 3ª | 4ª | 5ª |
|---|---|---|---|---|---|
| SMALL_FIX · BUG_SIMPLE | Devin SWE-2 Medium | Devin DeepSeek High | Devin Haiku 5.5 Medium | agy Gemini 3.8 Flash High | Codex Luna High |
| MECHANICAL_CHANGE · TEST_GENERATION | Devin SWE-2 High | Devin DeepSeek Max | agy Gemini High | Codex Luna Max | — |
| REFACTOR · MIGRATION · FEATURE | Devin Sol Medium ⇄ | Devin SWE-2 High ⇄ | Codex Sol Medium | — | — |
| CROSS_LAYER_FEATURE | Devin Sol Medium | Devin Sonnet 5.5 High | Codex Sol Medium | — | — |
| BUG_COMPLEX | Devin Sol High | Devin Sonnet 5.5 High | Codex Sol High | — | — |
| NATIVE_MOBILE | Devin Sol High | Codex Sol High | Devin Sonnet 5.5 High | — | — |
| ARCHITECTURAL_IMPL | Devin Sol High | Codex Sol High | — | — | — |

Por qué: el implementador general es **Devin / GPT-6.1 Sol / Medium** (mejor evidencia de disciplina de scope). SWE-2 es el especialista de tareas chicas y mecánicas, donde la diferencia de calidad no se nota y sus pocos pasos ayudan. Los benchmarks son casi todos auto-reportados, por eso el historial propio manda a la larga.

Los modelos fuera de esta tabla (Fusion, Luna en Devin, Gemini en Devin, Kimi, Opus en Devin) están fuera del pool. Opus solo corre en Claude Code.

## 3. Tiers

Un **tier** agrupa candidatos de calidad equivalente para esa clase. Solo dentro del mismo tier se aplica la preferencia de pago: **Devin → Antigravity → Codex**. El tier más bajo (número menor) siempre va primero aunque su pago sea menos preferido.

| Clase | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| SMALL_FIX · BUG_SIMPLE | SWE-2 Medium | DeepSeek High, Haiku Medium | agy Gemini High, Codex Luna High |
| MECHANICAL_CHANGE · TEST_GENERATION | SWE-2 High | DeepSeek Max | agy Gemini High, Codex Luna Max |
| REFACTOR · MIGRATION · FEATURE | Devin Sol Medium, Devin SWE-2 High | Codex Sol Medium | — |
| CROSS_LAYER_FEATURE | Devin Sol Medium | Sonnet High, Codex Sol Medium | — |
| BUG_COMPLEX | Devin Sol High | Sonnet High, Codex Sol High | — |
| NATIVE_MOBILE | Devin Sol High, Codex Sol High | Sonnet High | — |
| ARCHITECTURAL_IMPL | Devin Sol High, Codex Sol High | — | — |

Ejemplo: en NATIVE_MOBILE, Devin Sol High y Codex Sol High son el mismo tier, así que gana Devin por pago; Sonnet queda un tier abajo aunque sea Devin.

## 4. Algoritmo

1. **Filtro duro.** Un candidato sigue solo si: está en el catálogo con `enabled:true`, `doctor` encontró su CLI, el effort está en `allowedEfforts` y la cuota no está EXHAUSTED. Lo descartado aparece en `Excluded` con el motivo.
2. **Orden base:** la tabla de la sección 2.
3. **Pago:** dentro de un tier, Devin → agy → Codex.
4. **Cuota.**
   - PROTECTED (bajo la reserva semanal) → va al final de su tier, salvo que no haya alternativa en el tier o Reed lo autorice (`--allow-protected <provider>`).
   - CRITICAL con reset a más de 24 h → baja un tier.
   - Si el reset llega antes de la duración estimada de la clase, no se penaliza.
   - UNKNOWN no penaliza ni premia; la decisión lo marca como "quota unknown".
5. **Bootstrap** (sección 5).
6. **Historial.** Fuera del bootstrap, un candidato con 5 o más corridas en esa clase baja una posición si su tasa de `repairRequired + validationFailures` (corridas con repair o con VALIDATION_FAILURE, contadas una vez) supera en 25 puntos o más a la del siguiente de su tier (que debe tener al menos una corrida). La decisión lo explica.
7. **Salida:** el primero, y el **fallback por error de ejecución** (el siguiente candidato válido, que se recalcula en el momento del fallo con `--exclude`). PLAN_CONTRADICTION siempre muestra `fallback: NONE → back to Opus`.

Límites que el router **no** aplica solo y que debes cubrir tú con `--model`/`--effort`:
- Si la tarea o el repo exceden los 262K de contexto de SWE-2, fuerza Sol (1M): `--model devin/gpt-6-1-sol --effort medium`.
- SWE-2 `max` para MECHANICAL de más de 50 archivos solo si el historial muestra que rinde mejor.

## 5. Bootstrap

Objetivo: decidir con datos de los repos de Reed si SWE-2 High puede reemplazar a Sol Medium en REFACTOR, MIGRATION y FEATURE.

- Dura 10 corridas por clase (`bootstrap.runsPerClass`), alternando Devin Sol Medium y Devin SWE-2 High; el router elige el que tenga **menos corridas** en la clase (empate: Sol).
- Una tarea cuenta una sola vez: `history record` fusiona las corridas del mismo plan y el mismo `modelo@effort` (reintento por allowlist, repairs) en un registro, con el estado de la última, `repairs` máximo, duración sumada y `permissionRetry`. Guarda un hash del plan, nunca su ruta. Registrar dos veces el mismo runId es idempotente.
- No cuentan las corridas que terminan en PLAN_CONTRADICTION, EXECUTION_FAILURE, QUOTA_EXHAUSTED, RATE_LIMITED, TIMEOUT, MODEL_UNAVAILABLE, PROVIDER_UNAVAILABLE o PERMISSION_FAILURE: no miden calidad del modelo.
- Métricas al terminar: PASS sin repair, repairs promedio, flags de scope y de comentarios, VALIDATION_FAILURE y duración.
- Si SWE-2 iguala o supera a Sol en PASS sin repair y no tiene más flags de scope, sube a 1ª opción. Si no, Sol sigue 1ª. **Avisa a Reed antes de cambiar el orden** (`bootstrap.askBeforeReorder`).
- Un repair siempre lo hace el mismo worker, y se cuenta para el modelo de la corrida original: registra **solo la corrida original** con `orch history record <runId> --verdict <V> --repairs <N>` (N = ciclos de repair que necesitó), no las corridas de repair.
- `orch bootstrap status [--class C]` muestra las métricas y la recomendación (`IN_PROGRESS`, `PROMOTE_SWE2`, `KEEP_SOL`, `INSUFFICIENT_DATA`). Nada se reordena solo: con `PROMOTE_SWE2`, preséntale las métricas a Reed y, **solo si confirma**, ejecuta `orch bootstrap end --class <C> --promote devin/swe-2@high`; desde ahí el router pone a SWE-2 primero dentro de su tier. `orch bootstrap end --class <C>` sin `--promote` cierra el bootstrap sin cambiar el orden.
- `orch bootstrap reset --class <C>` reinicia el conteo desde ese momento y quita cualquier promoción; los agregados del historial se conservan.
- Historial: `history.json` guarda por corrida solo clase, modelo@effort, estado, veredicto, repairs, duración, flags y fecha. Nunca prompts, código, rutas ni secretos. Las corridas que nunca arrancaron (QUOTA_EXHAUSTED, RATE_LIMITED, MODEL_UNAVAILABLE, PROVIDER_UNAVAILABLE) quedan registradas pero no entran en los agregados.

## 6. Leer y corregir la decisión

Formato fijo (se muestra siempre antes de lanzar):

```
ROUTING DECISION
Task class: <clase>
Selected:   <Harness> / <Modelo> / <Effort>
Reason:     <por qué>
Quota:      <salud por ventana y fuente>
History:    <corridas en la clase>
Fallback if execution failure: <siguiente candidato>
PLAN_CONTRADICTION fallback: NONE → back to Opus
```

- `orch route --class <C> --explain` agrega los candidatos ordenados y los excluidos. Úsalo cuando la elección no sea la que esperabas.
- Para forzar un modelo: `orch run ... --model <id> --effort <e>`; valida contra el catálogo y rechaza modelos deshabilitados o efforts no permitidos.
- Para el fallback tras un fallo: repite `orch run` con `--exclude <id>@<effort>` (lista separada por comas).
- Si el candidato elegido tiene cuota UNKNOWN, dilo en tu mensaje a Reed.
