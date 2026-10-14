# Subagentes del Tech Lead

Cada turno del Tech Lead vuelve a leer todo su contexto. Los volcados de Figma y la lectura del diff de la auditoría inflaban ese contexto hasta 300-500K tokens, que luego se pagaban en cada turno siguiente. Ese trabajo va a subagentes de Claude Code (herramienta `Agent`): empiezan con contexto limpio, comparten los MCP de la sesión y devuelven solo un resumen corto. `orch usage report` los cuenta en una fila propia, `<modelo> (subagentes)`.

Los dos escriben solo en las rutas que el hook permite (`.orchestrator/plans/*.md|json` y `runs/<runId>/audit.md`). Ninguno edita el producto ni lanza workers.

## 1. Lector de Figma: Haiku 5.5

`Agent` con `subagent_type: "general-purpose"` y `model: "haiku"`. Extraer valores es mecánico, y Haiku 5.5 cuesta unas 40 veces menos que Opus. El lector es siempre Haiku 5.5 (no es configurable): si una extracción vuelve incompleta, anota las dudas y resuélvelas con una consulta puntual por MCP, sin escalar de modelo.

Opus no llama `get_design_context` ni `get_metadata`. Puede pedir hasta 3 `get_screenshot` para ver la pantalla; una imagen pesa poco frente a un volcado.

El MCP de Figma tiene cuota de uso. Una extracción nodo por nodo (95 llamadas en una tarea real) la agotó y dejó al auditor sin capturas. Por eso el prompt limita las llamadas y reserva las capturas para Opus y el auditor.

Prompt (completa los `<>`):

```text
Extrae una spec de diseño desde Figma para un plan de implementación. No escribas código ni toques archivos del proyecto.
Fuente: <URLs o node ids, uno por pantalla/estado>
Pantallas y estados pedidos: <lista>
Repo (solo para nombrar destinos de assets): <ruta>
Escribe UN archivo: <repo>/.orchestrator/plans/<id>-figma.md

El MCP de Figma tiene cuota: gástala lo mínimo.
- get_design_context: UNA llamada por pantalla o estado pedido, sobre el frame completo; ya devuelve todo su árbol. No bajes nodo por nodo.
- get_metadata: solo si la respuesta de un frame viene truncada; entonces pide get_design_context para sus secciones grandes, no para cada hijo.
- get_variable_defs: una vez.
- No uses get_screenshot: las capturas quedan para el Tech Lead y el auditor.
- Tope: 2 llamadas por pantalla más 3 extra. Si no alcanza, anota lo que faltó en "Dudas".
Copia los valores literalmente; no los traduzcas a componentes del repo ni redondees nada.
Para cada pantalla y estado, por nodo relevante (de arriba abajo):
- nombre y node id; tamaño; auto-layout (dirección, gap, padding, alineación); radio; borde; sombra
- relleno y color de texto: nombre de la variable y su hex
- tipografía: familia, peso, tamaño, line-height, letter-spacing y nombre del estilo
- texto exacto, sin resumirlo
- instancias de componente: nombre del componente y sus props de variante
- imágenes e íconos: la URL que devuelve el MCP y un nombre de archivo sugerido
Al final, una tabla de variables (nombre → valor) y una lista "Dudas" con lo que no pudiste obtener.

Responde en 10 líneas como máximo: la ruta del archivo, las pantallas cubiertas y las dudas. No pegues la spec en la respuesta.
```

Opus lee `<id>-figma.md`, decide el mapeo a los tokens y componentes del repo y lo lleva al plan (`## Visual reference`). Si quedan dudas que bloquean, pregunta una consulta puntual por MCP (un nodo) o pregunta a Reed. No repitas la extracción completa.

## 2. Auditor: modelo configurable (por defecto hereda el del Tech Lead)

`Agent` con `subagent_type: "general-purpose"`. El `model` sale de `orch architect --json → auditor.model`: con `inherit` (por defecto) omite el parámetro y hereda al Tech Lead, porque juzgar el diff requiere el mismo criterio que el plan; con `sonnet`, `haiku` o un id completo pásalo tal cual. Se cambia con `orch architect set --auditor <inherit|sonnet|haiku|opus>`. Lánzalo después de que `orch go` notifique un SUCCESS o un VALIDATION_FAILURE, o en la vía 3 de PERMISSION_FAILURE. Para auditar un repair, **continúa el mismo auditor con `SendMessage`** pasándole la nueva salida de `orch go`: ya conoce el diff y no vuelve a leerlo entero. `SendMessage` puede ser una herramienta diferida: cárgala con ToolSearch. Si no existe, lanza un auditor nuevo con el mismo prompt.

Prompt (completa los `<>`):

```text
Eres el auditor del Tech Lead de este repo. No edites archivos del producto, no hagas commit y no lances workers.
Run: <runId>   Plan: <ruta del plan>   Ciclo de repair: <0|n>
Combinación: <harness / modelo / effort>
Spec visual: <ruta de <id>-figma.md, o "ninguna">
Salida de orch go (postflight incluido):
<pega la salida tal cual>

1. Lee ~/.claude/skills/orchestrator/references/audit-checklist.md, secciones 1 a 4, y aplícalas.
2. Revisa git status y git diff frente al snapshot. Verifica cada paso del plan en el código y cada hallazgo del postflight, uno por uno.
3. Solo si el plan tiene "## Visual reference": compara solo los estados y tamaños que pide el plan. Cada captura llena tu contexto, que se vuelve a leer en cada turno:
   - Verifica primero con texto: get_page_text o read_page para textos, estados, presencia de elementos y comportamiento; javascript_tool para medidas o estilos puntuales.
   - Capturas: una por estado pedido, a escala 0.5, y solo para lo que el texto no muestra (layout, ilustraciones, sombras). Agrupa las acciones de cada estado en un solo browser_batch.
   - Referencia: get_screenshot de Figma, una por pantalla. Si Figma no responde (cuota), compara contra la spec visual.
   - Si comparas texto contra un documento, hazlo línea por línea.
4. Escribe .orchestrator/runs/<runId>/audit.md con el formato del checklist.
5. Si el veredicto es REPAIR_REQUIRED, escribe .orchestrator/plans/<id>-repair<ciclo+1>.json con {"cycle":N,"points":[{"file","line","issue","expected"}],"commands":[...]}.

Responde en 15 líneas como máximo:
Verdict: PASS | REPAIR_REQUIRED
Pasos: <n>/<total>
Puntos bloqueantes: uno por línea, con archivo:línea
Repair: <ruta del json o "—">
Visual: <qué comparaste y qué difiere, o "no aplica">
Pendientes para Reed: <lo que el run no cubre>
Para project-context: <rutas, componentes y variantes, tokens, hooks o casos de uso que la tarea agregó o cambió; una línea cada uno con su ruta, o "—">
```

Opus confía en ese veredicto, salvo una contradicción visible con la salida de `orch go` (por ejemplo, PASS con `POSTFLIGHT NOT OK`). En ese caso se lo devuelve al mismo auditor con `SendMessage`; no relee el diff él mismo.
