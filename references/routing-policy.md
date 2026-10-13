# Recomendación y elección del worker

Léelo al clasificar la tarea y preparar las opciones. Opus analiza el proyecto y recomienda; Reed elige antes de ejecutar. El runner no lanza desde `route` ni elige implícitamente desde `run`.

## Clases

Clasifica por el riesgo y la extensión del cambio, no por el lenguaje o el nombre del proyecto:

| Clase | Qué incluye | Duración estimada (min) | Timeout (min) |
|---|---|---|---|
| SMALL_FIX | Cambio pequeño y localizado | 15 | 20 |
| BUG_SIMPLE | Causa conocida, fix localizado | 20 | 25 |
| MECHANICAL_CHANGE | Cambio repetitivo entre archivos | 30 | 40 |
| TEST_GENERATION | Pruebas sobre código existente | 30 | 40 |
| REFACTOR | Reestructuración sin cambiar comportamiento | 45 | 60 |
| MIGRATION | Cambio de versión, esquema o API | 60 | 90 |
| FEATURE | Funcionalidad con un plan definido | 60 | 75 |
| CROSS_LAYER_FEATURE | Funcionalidad que cruza capas | 75 | 90 |
| BUG_COMPLEX | Causa incierta o varias capas afectadas | 60 | 75 |
| NATIVE_MOBILE | Código y herramientas nativas Android/iOS | 75 | 90 |
| ARCHITECTURAL_IMPL | Implementación de una arquitectura definida | 90 | 120 |

El effort mínimo suficiente está en `effort-policy.md`. No cambies la clase para conseguir un worker preferido.

Los efforts de la tabla son la base. Si el alcance exige otro nivel permitido, Opus lo justifica y lo refleja en las opciones de la pregunta antes de pedir la elección. El lanzamiento conserva el effort que Reed eligió, incluso cuando difiere del nivel base de la clase.

## Conjunto autorizado

Devin: SWE-2, GPT-6.1 Sol, Sonnet 5.5, Haiku 5.5, DeepSeek V4.1 Flash. Codex: GPT-6.1 Sol, GPT-6 Luna. Antigravity: Gemini 3.8 Flash. Los modelos y efforts deben estar habilitados y disponibles en el catálogo local; una nueva familia descubierta no se habilita automáticamente. Opus 5.5 permanece como Tech Lead en Claude Code.

## Orden base por clase

Son recomendaciones iniciales, no garantías de calidad. El plan y el historial aportan la evidencia; cada opción incluye un motivo breve. Ofrece una recomendación y otras tres opciones cuando hay cuatro candidatos válidos. No inventes ni dupliques modelos si hay menos.

| Clase | Recomendado | Alternativas |
|---|---|---|
| SMALL_FIX · BUG_SIMPLE | Devin SWE-2 Medium | Devin DeepSeek High; Devin Haiku Medium; agy Gemini High; Codex Luna High |
| MECHANICAL_CHANGE · TEST_GENERATION | Devin SWE-2 High | Devin DeepSeek Max; agy Gemini High; Codex Luna Max |
| REFACTOR · MIGRATION · FEATURE | Devin Sol Medium | Devin SWE-2 High; Devin Sonnet Medium; Codex Sol Medium |
| CROSS_LAYER_FEATURE | Devin Sol Medium | Devin Sonnet High; Codex Sol Medium; Devin SWE-2 High |
| BUG_COMPLEX | Devin Sol High | Devin Sonnet High; Codex Sol High; Devin SWE-2 High |
| NATIVE_MOBILE · ARCHITECTURAL_IMPL | Devin Sol High | Codex Sol High; Devin Sonnet High; Devin SWE-2 High |

SWE-2 es la alternativa especializada para trabajo acotado o mecánico; en una tarea compleja debe llevar un plan especialmente preciso. Si el repo o la tarea exceden su contexto, exclúyelo antes de ofrecer opciones. No subas effort para compensar un plan incompleto.

El runner ordena por tier de adecuación para la clase y, dentro del mismo tier, por la preferencia existente Devin → Antigravity → Codex. Los porcentajes de cuota, reservas semanales y estados HEALTHY/CRITICAL/PROTECTED no afectan ese orden. La cuota se consulta solo si Reed pide el diagnóstico.

## Historial

Un candidato con al menos cinco corridas en la clase baja una posición dentro de su tier si su tasa de problemas supera en 25 puntos porcentuales a la siguiente opción, que debe tener al menos una corrida. Repairs y VALIDATION_FAILURE se cuentan una vez por corrida. La salida explica el ajuste.

El bootstrap ya no alterna Sol/SWE-2 automáticamente, incluso con configuraciones antiguas que lo tenían habilitado. `bootstrap status/end/reset` se conserva para analizar datos y preferencias explícitas. Una promoción aprobada por Reed puede cambiar la recomendación dentro de su tier; nunca sustituye la elección por tarea.

## Pregunta después del plan

1. `orch route --class <C> --json` devuelve `recommended`, `options`, `requiresSelection: true`, exclusiones y el objeto `question` listo para `AskUserQuestion`.
2. Opus explica por qué la primera opción encaja con el plan y usa ese objeto como input de **`AskUserQuestion`** en la sesión principal. Una pregunta, selección única, cuatro opciones como máximo. Con un candidato se puede elegirlo o "No ejecutar"; sin candidatos no hay payload de pregunta y se explican las exclusiones.
3. Espera la respuesta. Una opción preseleccionada, silencio, Skip o respuesta vacía no permiten ejecutar. Si la herramienta no está disponible, pregunta en texto y espera. Si la combinación ya fue elegida explícitamente por Reed para esta misma tarea, respétala.
4. Resuelve la opción al `id` y `effort` exactos; una respuesta libre también se valida contra el catálogo. Registra la elección en el plan. Solo entonces lanza en background con `orch go --plan <ruta> --class <C> --model <id> --effort <e> --project-rules <extracto>` (hace el preflight en el primer lanzamiento).

La herramienta de pregunta la invoca Claude Code; imprimir el JSON en el terminal no abre por sí solo la UI. Es el flujo documentado de [AskUserQuestion](https://code.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions).

## Fallos y nuevas elecciones

- Un repair, reintento o continuation con la misma combinación aprobada puede seguir sin repetir la pregunta. Si cambia worker, modelo o effort, muestra opciones y espera otra elección.
- Un límite de cuota observado se registra con `orch quota exhausted <provider>`. Solo un marcador reactivo no caducado excluye temporalmente al provider (1 h); no se consulta su porcentaje. `--exclude <id>@<effort>` permite excluir un candidato concreto tras un fallo.
- Antes de escribir: propone alternativas. Si ya hay cambios: prepara continuation con lo hecho y lo pendiente. Nunca reinicies a ciegas.
- PLAN_CONTRADICTION vuelve a Opus para corregir el plan, sin proponer otro worker como solución a un plan incorrecto.
- Si la combinación elegida queda deshabilitada o no está disponible, `run` falla y no la sustituye.
