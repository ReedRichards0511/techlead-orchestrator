# techlead-orchestrator

Skill global de Claude Code (`/orchestrator`). **Opus 5.5 actúa como Tech Lead**: entiende el requerimiento, escribe el plan, elige el worker y el effort, supervisa y audita el diff. La implementación la hacen workers de otros CLIs (Devin, Codex y Antigravity), sin API keys de pago, usando las suscripciones ya iniciadas en cada CLI.

El runner (`scripts/orch.mjs`) es un único programa Node sin dependencias. No usa Python ni LLM para decidir nada: routing, cuotas, locks, snapshots, postflight y clasificación de errores son deterministas.

## Requisitos

- Node.js **>= 20** (para correr los tests, Node >= 21 por el glob de `node --test`).
- Git.
- Claude Code (CLI o Desktop, sesión **local**; en cloud/Cowork no puede lanzar workers).
- Los CLIs de los workers que quieras usar, con sesión iniciada: `devin`, `codex` y `agy` (Antigravity). Los que falten simplemente no se ofrecen en el routing; `orch doctor` dice cuáles hay.
- Probado en **Windows 11**. macOS: sin verificar (ver Estado).

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

## Reglas que impone el runner

- Un solo escritor por working tree (lock atómico).
- `PLAN_CONTRADICTION` nunca dispara fallback: vuelve a Opus.
- Los workers no hacen commit ni agregan comentarios al código; el postflight lo comprueba.
- Cuota desconocida nunca se trata como 100%. Nunca se usan los reset credits de Codex.
- No se guardan ni se muestran emails, tokens, API keys ni IDs de cuenta. `history.json` no contiene prompts, código ni rutas.

## Desarrollo y tests

```bash
npm test      # o: node --test "scripts/test/*.test.mjs"
```

`npm test` carga una guarda (`ORCH_FORBID_REAL_WORKERS=1`) que impide lanzar devin, codex o agy. Los tests no lanzan workers reales ni tocan tu estado (`ORCH_STATE_DIR` lo redirige a un directorio temporal). Para añadir comportamiento se escribe primero el test (TDD con `node:test`).

- `scripts/lib/`: módulos del runner (router, cuotas, adapters, seguridad, historial…).
- `scripts/test/live/smoke.mjs`: humo con workers reales, **a mano** y no forma parte de `npm test`.
- `evals/`: casos de evaluación de la skill (skill-creator).
- `docs/plan-orchestrator.md`: documento de diseño completo (decisiones D1–D17, fases F0–F11).

## Estado

| Pendiente | Detalle |
|---|---|
| Cuota de Devin (capa 1) | Sin lectura viva: queda en UNKNOWN y se usa el fallback reactivo, el conteo local y el dato manual (`orch quota set devin ...`) |
| Statusline de Claude | Script listo y probado (`references/statusline.md`) pero **no instalado**; la cuota de Claude queda UNKNOWN |
| macOS (F11) | Sin inspeccionar ni probar |
| E2E (F9) | Hecho solo el caso feliz: flujo completo (preflight, route, run, wait, postflight, auditoría, history) con Devin real sobre un repo todo-app desechable, más humo real de Codex y Antigravity. Sin ejecutar: PLAN_CONTRADICTION, repair, cuota agotada antes de trabajar y continuation, en E2E reales |
| Repairs | El runner cuenta los repairs por plan y rechaza el tercero (`repairMaxCycles`, 2 por defecto); el número de ciclo del packet lo calcula él, no Opus |
| Untracked y postflight | El snapshot copia el contenido de los untracked previos (hasta 5 MB por archivo y 50 MB en total) y el postflight da el comando para recuperarlos si el worker los modifica o borra; `postflight.ok` exige clasificación SUCCESS y cambios reales. Sin tests propios (decisión de Reed) |
| Dev server | Tras la validación, si hay un dev server escuchando y cambió la salida de build (`.next`, `dist`, `build`, `.nuxt`, `*.tsbuildinfo`…), el postflight lo avisa en `notes` y en `devServer` con los pasos de recuperación (en Next.js: borrar `.next` y reiniciar `next dev`). Solo avisa: no borra ni reinicia nada |
| Scope | `SOFT_SCOPE_VIOLATION` (aviso) para archivos del repo que el plan no lista; `HARD_SCOPE_VIOLATION` (grave, PARA) si cambian `.git/config`, hooks de git, `~/.gitconfig`, `~/.npmrc` o `settings.json` de Claude. Escrituras en otros proyectos o rutas fuera del repo siguen sin detectarse |
| Allowlist de Devin | Verificada con `rm` y comandos de validación simples. Sin verificar con `npm.cmd`, `npx.cmd` en Windows |

## Licencia

MIT (ver `LICENSE`).

## Actualizar o desinstalar

```bash
git -C ~/.claude/skills/orchestrator pull
```

Para desinstalar, borra `~/.claude/skills/orchestrator` y, si quieres, `~/.claude/orchestrator/` (estado local).
