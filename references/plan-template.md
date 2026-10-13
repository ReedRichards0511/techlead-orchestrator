# Plantilla del plan

El plan es la única fuente de verdad del worker: lo lee completo desde `PLAN_PATH` y el packet **no lo copia**. Un plan flojo produce PLAN_CONTRADICTION, scope creep o repairs. Léelo en el paso 5 del flujo.

Ruta: `<repo>/.orchestrator/plans/<id>.md`. El `<id>` es el nombre del archivo sin `.md` y también nombra el lock y el snapshot de la tarea; usa algo corto y único (`rn-login-timeout`). Escríbelo en español; los nombres de archivos, símbolos y comandos van tal cual.

## Plantilla

```markdown
# Plan <id>: <título>
Class: <clase> · Estimated files: <n> · Effort justification: <solo si pides xhigh/max>
Worker chosen: <id> · Effort: <e> · User choice: <respuesta de Reed; completar solo después de su elección>

## Context
Requerimiento, criterios de aceptación y reglas del proyecto relevantes.

## Current state (verified)
Archivos, símbolos y patrones existentes, con rutas y líneas (`src/auth/login.ts:42`).
Es la base para detectar contradicciones: solo lo que verificaste leyendo el repo.

## Architecture decisions
Qué se hace y por qué, qué NO se hace y las alternativas descartadas.

## Scope
- In scope: src/auth/login.ts, src/auth/login.test.ts
- Out of scope: todo lo demás, en especial package.json y lockfiles

## File operations
- None

## Criterios fuera de este repo
- <criterio> · vive en: <otro repo / servicio / contenido de un tercero> · quién lo cubre: <Reed / equipo X>

## Visual reference
- Reference: <URL, captura o documento visual aportado> · Documento fuente del texto: <ruta o nombre>
- Design context: <tokens, medidas, estados y comportamiento verificados por el Tech Lead; assets disponibles en rutas locales>
- Design ownership: el Tech Lead resuelve la referencia y verifica visualmente; el worker implementa con este contexto, sin consultas MCP de diseño salvo asignación explícita en el plan

## Steps
1. <paso atómico> · files: src/auth/login.ts · symbols: refreshToken · expected: <resultado observable>
2. ...

## Naming & patterns to follow
## Data / API contracts
## Edge cases

## Validation
- Commands: `npm run typecheck` `npm test`
- Baseline: se completa en el preflight
- Done when: <criterios verificables>

## Risks
```

## Plan ligero

Solo para el modo ligero de `SKILL.md` (SMALL_FIX o BUG_SIMPLE, 3 archivos o menos, sin riesgo alto):

```markdown
# Plan <id>: <título>
Class: <SMALL_FIX|BUG_SIMPLE> · Mode: light · Estimated files: <n>
Worker chosen: <id> · Effort: <e> · User choice: <respuesta de Reed>

## Context
<requerimiento y criterio de aceptación, en 1 a 3 líneas>

## Current state (verified)
- `ruta` · símbolo: <lo que hay hoy>

## Scope
- In scope: <archivos>
- Out of scope: todo lo demás

## Steps
1. <cambio> · files: <ruta> · expected: <resultado observable>

## Validation
- Commands: `<comando real>`
- Done when: <criterio verificable>
```

## Formato que parsea el runner

El preflight, el lanzamiento y el postflight exigen dos secciones parseables y no vacías. Si faltan o el formato difiere, la corrida se rechaza:

- `## Scope`: líneas `- In scope: a, b, c` y `- Out of scope: ...` (valores separados por coma, con o sin backticks), o una lista anidada debajo de cada una. Se aceptan carpetas (`src/auth/`) y globs (`src/**/*.ts`). Todo archivo tocado fuera de "In scope" se marca para la auditoría.
- `## Validation`: `- Commands:` seguido de comandos entre backticks en la misma línea, separados por `;`, o una lista anidada. Son comandos **reales** que ya verificaste en el repo.
- `## File operations` (cuando corresponda): una línea Move con origen y destino separados por `->`, o Delete con la ruta; las rutas van entre backticks. Fuentes existentes, destinos libres, archivos concretos dentro del Scope. El worker usa los helpers que genera el runner, no Git ni comandos de borrado. Sin operaciones: `- None`. Ejemplo completo en `references/execution-policy.md`.

Los comandos de validación se ejecutan con un shell real (`cmd.exe` en Windows, `sh` en macOS/Linux). Los escribes tú, no el worker: no copies texto no confiable del requerimiento dentro de ellos. Cualquier comando que contenga un `forbiddenCommands` (`git commit`, `npm publish`, ...) se bloquea.

## Cómo escribir un buen plan

- **Verifica antes de afirmar.** Cada símbolo y ruta en "Current state" tiene que existir. Un plan que asume mal el repo es la causa número uno de PLAN_CONTRADICTION.
- **Verifica los tipos reales.** Lee las definiciones instaladas y registra la evidencia antes de afirmar compatibilidad entre interfaces/uniones. Ejecuta `orch check-plan --plan <ruta>` y resuelve errores antes de recomendar workers.
- **Pasos atómicos y ordenados**, cada uno con archivos, símbolos y resultado esperado. El worker implementa todo de una vez y sin preguntar: lo que no esté escrito, lo improvisa.
- **Scope exacto.** Lista archivos, no áreas. Los archivos nuevos también van en "In scope".
- **Nada de comentarios o docs inline.** Los workers no agregan comentarios: `check-plan` rechaza el plan que los pida y el worker omitiría ese comentario. Si hace falta documentación, que sea un archivo aparte y dentro del scope.
- **Manifests y lockfiles** (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `Podfile.lock`, `build.gradle`, ...) fuera del scope salvo que la tarea sea de dependencias; si cambian sin que el plan lo pida, el postflight lo marca como violación.
- **Criterios "Done when" verificables** por comando, no por opinión.
- **Criterios fuera de este repo.** Si un criterio de aceptación depende de otro repo, un servicio o contenido de un tercero (por ejemplo boletines o textos que entrega otro equipo), no lo metas en "Done when" ni en los pasos: el worker no puede cumplirlo y generaría PLAN_CONTRADICTION. Va en "Criterios fuera de este repo", se avisa a Reed en el paso 2 y se lista como pendiente al cerrar. El runner no parsea esa sección; es para ti y para Reed. Si no hay ninguno, borra la sección.
- **Referencia visual (opcional).** Si la tarea aporta una referencia externa (Figma, captura u otra fuente), "Visual reference" lleva esa fuente y el contexto de diseño ya verificado. Una URL sola no basta para implementar. El lector de Figma (`references/subagents.md`) extrae la spec, el Tech Lead la traduce a tokens y componentes del repo y proporciona las rutas de assets; asigna consultas al worker solo si la tarea realmente lo exige. Habilita la verificación visual del auditor. Sin referencia, borra la sección y usa los patrones existentes del proyecto.
- Para clases MIGRATION y ARCHITECTURAL_IMPL, agrega "Risks" con qué se rompe si un paso falla a medias.
