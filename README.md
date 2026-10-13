# techlead-orchestrator

Skill global de Claude Code (`/orchestrator`). **Opus 5.5 actúa como Tech Lead**: entiende el requerimiento, escribe el plan, recomienda worker/modelo/effort, supervisa y audita el diff. **El usuario elige antes de ejecutar**: una recomendación y hasta tres alternativas de los modelos autorizados. La implementación la hacen workers de otros CLIs (Devin, Codex y Antigravity), sin API keys de pago, usando las suscripciones ya iniciadas en cada CLI.

El runner (`scripts/orch.mjs`) es un único programa Node sin dependencias. No usa Python ni LLM para decidir nada: routing, cuotas, locks, snapshots, postflight y clasificación de errores son deterministas.

Es agnóstico al proyecto: toma del repo sus reglas, arquitectura y comandos de validación, y del plan el alcance de cada tarea. Puede usarse en distintos lenguajes y stacks sin requerir Figma ni una aplicación de UI; mantiene los requisitos de ejecución indicados abajo.

## Requisitos

- Node.js **>= 20** (para correr los tests, Node >= 21 por el glob de `node --test`).
- Git.
- Claude Code **>= 2.1.295** (CLI o Desktop, sesión **local**; requiere hooks con bloqueo ante fallos para proteger el rol del Tech Lead; en cloud/Cowork no puede lanzar workers).
- Los CLIs de los workers que quieras usar, con sesión iniciada: `devin`, `codex` y `agy` (Antigravity). Los que falten simplemente no se ofrecen en el routing; `orch doctor` dice cuáles hay.
- Probado con workers reales en **Windows 11**. En **macOS arm64**, suite automática con workers simulados y una implementación real de Devin / Sol Medium validada manualmente; quedan pendientes las pruebas reales de Codex y Antigravity en macOS.

## Instalación

La carpeta debe llamarse `orchestrator` y estar en `~/.claude/skills/`:

```bash
git clone git@github.com:ReedRichards0511/techlead-orchestrator.git ~/.claude/skills/orchestrator
```

En Windows PowerShell:

```powershell
git clone git@github.com:ReedRichards0511/techlead-orchestrator.git "$env:USERPROFILE\.claude\skills\orchestrator"
```

No hay `npm install`. Después, en la carpeta de la skill:

```bash
node scripts/orch.mjs doctor          # SO, CLIs, sesiones y versiones
node scripts/orch.mjs models refresh  # descubre los modelos de cada CLI y crea el catálogo
node scripts/orch.mjs quota           # diagnóstico opcional de cuotas
```

La configuración, catálogo, cuotas e historial global se guardan en `~/.claude/orchestrator/` y **no están en este repo**. Planes, corridas y cierres de tokens se guardan en `.orchestrator/` del proyecto donde trabajas. La primera ejecución copia `config.defaults.json` a `~/.claude/orchestrator/config.json`; ahí puedes ajustar umbrales, reservas, timeouts y rutas absolutas de los CLIs si Claude Desktop no hereda tu `PATH`.

Reinicia Claude Code para que aparezca `/orchestrator`.

Si ya clonaste el repo en otra carpeta de macOS, puedes usar un enlace en lugar de clonarlo otra vez (el destino debe estar libre):

```bash
mkdir -p "$HOME/.claude/skills"
ln -s "/ruta/al/techlead-orchestrator" "$HOME/.claude/skills/orchestrator"
```

En macOS el runner encuentra ejecutables en `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` y `~/.devin/bin`. Si Desktop no los ve, configura `platformOverrides.paths` con las rutas absolutas que devuelve `command -v <CLI>`. `doctor` exige una sesión autenticada de Claude; si indica `failed`, ejecuta `claude auth login`.

## Uso

La skill solo la invoca el usuario (`disable-model-invocation: true`). Abre la sesión **dentro del repo donde se va a implementar**:

```
/orchestrator doctor
/orchestrator quota
/orchestrator route --class SMALL_FIX
/orchestrator implement <HU / bug / requerimiento>
/orchestrator history
/orchestrator bootstrap status
/orchestrator usage report --task <id>
```

`implement` registra el inicio del consumo y sigue este flujo: doctor, plan en `.orchestrator/plans/`, clasificación, recomendación, **pregunta interactiva y elección**, preflight (lock + snapshot + baseline de validación), lanzamiento, espera, postflight, auditoría (máximo 2 ciclos de repair) y cierre con tokens. La elección usa `AskUserQuestion` en Claude Code; si no está disponible, espera una respuesta en texto. Sin elección no toma el lock ni lanza workers. Las cuotas no se consultan en este flujo ni alteran el orden por porcentajes o reservas; el bootstrap tampoco alterna workers automáticamente. **Nunca hace commit.** El detalle está en `SKILL.md` y `references/`.

El lanzamiento exige la combinación elegida con `--model <id> --effort <e>`, recibe el extracto de reglas con `--project-rules <archivo>` y carga automáticamente el baseline del preflight. Si esa combinación deja de estar disponible, falla sin sustituirla. El plan debe incluir `## Scope` con `- In scope:` y `## Validation` con `- Commands:`, ambos no vacíos; el runner rechaza planes que no pueda comprobar. El JSON de `route` ahora usa `recommended`, `options` y `question`, no `selected`/`fallback`.

Antes de elegir worker, `orch check-plan --plan <ruta>` comprueba estructura, conflictos reconocibles y operaciones de archivos. `## File operations` declara movimientos/eliminaciones concretos: el preflight respalda sus fuentes y el worker ejecuta helpers exactos, temporalmente autorizados en Devin smart. Opus tiene hooks que bloquean edición directa y shell mutante sobre el producto mientras su tarea esté abierta; solo escribe planes, packets y auditorías. `orch go` hace preflight, lanzamiento, espera y postflight en una sola llamada en Bash background, sin polling del modelo; `orch close` libera el lock, registra el historial e imprime los tokens. La extracción de Figma (Haiku) y la auditoría (Opus con contexto limpio) van a subagentes (`references/subagents.md`). Consulta `references/execution-policy.md`.

## Reglas que impone el runner

- Un solo escritor por working tree (lock atómico).
- `PLAN_CONTRADICTION` nunca dispara fallback: vuelve a Opus.
- Los workers no hacen commit ni agregan comentarios al código; el postflight lo comprueba.
- Los porcentajes de cuota son diagnóstico opcional. Los límites observados durante una corrida se conservan para proponer alternativas; cambiar de combinación requiere elección del usuario. Nunca se usan los reset credits de Codex.
- No se guardan ni se muestran emails, tokens de acceso, API keys ni IDs de cuenta. `history.json` no contiene prompts, código ni rutas.

`status` y `wait` muestran los contadores disponibles de cada harness; `history record` los guarda y `history` los muestra. Cada `implement` registra `orch usage start --task <id> --session "${CLAUDE_SESSION_ID}"` antes del análisis y cierra con `orch close` (o `orch usage report --task <id> --session "${CLAUDE_SESSION_ID}"`): una línea por modelo del arquitecto, de sus subagentes y por worker/modelo/effort, más el total medido, incluyendo reintentos y repairs. La caché se informa por separado sin sumarla dos veces. Datos faltantes se muestran como no disponibles y hacen parcial el total. El cierre se guarda localmente y excluye la respuesta final de Claude. No estima dinero ni ahorro; consulta `references/token-accounting.md` para fuentes y límites. El dashboard de cuotas sigue siendo opcional e independiente.

## Desarrollo y tests

```bash
npm test      # o: node --test "scripts/test/*.test.mjs"
```

`npm test` carga una guarda (`ORCH_FORBID_REAL_WORKERS=1`) que impide lanzar devin, codex o agy. Los tests no lanzan workers reales ni tocan tu estado (`ORCH_STATE_DIR` lo redirige a un directorio temporal). Para añadir comportamiento se escribe primero el test (TDD con `node:test`).

- `scripts/lib/`: módulos del runner (router, cuotas, adapters, seguridad, historial…).
- `scripts/test/live/smoke.mjs`: humo con workers reales, **a mano** y no forma parte de `npm test`.
- `evals/`: casos de evaluación de la skill (skill-creator).
- `docs/plan-orchestrator.md`: documento de diseño completo (decisiones D1–D17, fases F0–F11).

## Licencia

MIT (ver `LICENSE`).

## Actualizar o desinstalar

```bash
git -C ~/.claude/skills/orchestrator pull
```

Para desinstalar, borra `~/.claude/skills/orchestrator` y, si quieres, `~/.claude/orchestrator/` (estado local).
