# techlead-orchestrator

Skill global de Claude Code (`/orchestrator`). **Opus 5.5 actúa como Tech Lead**: entiende el requerimiento, escribe el plan, elige el worker y el effort, supervisa y audita el diff. La implementación la hacen workers de otros CLIs (Devin, Codex y Antigravity), sin API keys de pago, usando las suscripciones ya iniciadas en cada CLI.

El runner (`scripts/orch.mjs`) es un único programa Node sin dependencias. No usa Python ni LLM para decidir nada: routing, cuotas, locks, snapshots, postflight y clasificación de errores son deterministas.

Es agnóstico al proyecto: toma del repo sus reglas, arquitectura y comandos de validación, y del plan el alcance de cada tarea. Puede usarse en distintos lenguajes y stacks sin requerir Figma ni una aplicación de UI; mantiene los requisitos de ejecución indicados abajo.

## Requisitos

- Node.js **>= 20** (para correr los tests, Node >= 21 por el glob de `node --test`).
- Git.
- Claude Code (CLI o Desktop, sesión **local**; en cloud/Cowork no puede lanzar workers).
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
node scripts/orch.mjs quota           # dashboard de cuotas
```

El estado local (configuración, catálogo, cuotas, historial) se crea solo en `~/.claude/orchestrator/` y **no está en este repo**. La primera ejecución copia `config.defaults.json` a `~/.claude/orchestrator/config.json`; ahí puedes ajustar umbrales, reservas, timeouts y rutas absolutas de los CLIs si Claude Desktop no hereda tu `PATH`.

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
```

`implement` sigue 15 pasos: doctor, plan en `.orchestrator/plans/`, clasificación, cuota, routing, preflight (lock + snapshot + baseline de validación), lanzamiento, espera, postflight, auditoría (máximo 2 ciclos de repair) y cierre. **Nunca hace commit.** El detalle está en `SKILL.md` y `references/`.

El lanzamiento recibe el extracto de reglas con `--project-rules <archivo>` y carga automáticamente el baseline del preflight. El plan debe incluir `## Scope` con `- In scope:` y `## Validation` con `- Commands:`, ambos no vacíos; el runner rechaza planes que no pueda comprobar.

## Reglas que impone el runner

- Un solo escritor por working tree (lock atómico).
- `PLAN_CONTRADICTION` nunca dispara fallback: vuelve a Opus.
- Los workers no hacen commit ni agregan comentarios al código; el postflight lo comprueba.
- Cuota desconocida nunca se trata como 100%. Nunca se usan los reset credits de Codex.
- No se guardan ni se muestran emails, tokens de acceso, API keys ni IDs de cuenta. `history.json` no contiene prompts, código ni rutas.

`status` y `wait` muestran los tokens que Devin exporta por corrida; `history record` los guarda y `history` los muestra. Cache, prompt y salida se conservan como contadores separados, sin estimar costos. El consumo del arquitecto y de otros harnesses sigue sin medirse; los reintentos y repairs deben incluirse al resumir la tarea. El dashboard informa cuota disponible. Estos datos todavía no demuestran un porcentaje de ahorro: hace falta un baseline equivalente.

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
