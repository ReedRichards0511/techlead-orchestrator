# Plan de implementación — Skill global `orchestrator` para Claude Code

> **Flujo actual (2026-10-13):** la implementación recomienda una combinación y hasta tres alternativas del conjunto autorizado; Reed elige con `AskUserQuestion` después del análisis y el plan, antes del preflight. `run` exige modelo y effort explícitos. Las cuotas son diagnóstico opcional, los porcentajes/reservas no afectan las recomendaciones y el bootstrap no alterna workers. Se conserva la detección reactiva de límites. Las secciones históricas de selección automática y cuotas de este documento quedan reemplazadas por `SKILL.md` y `references/routing-policy.md`.

> Estado: **BORRADOR PARA REVISIÓN**. No hay nada implementado.
> Fecha: 2026-10-12 · Autor: Claude (Opus 5.5) junto con Reed
> Plataformas objetivo: **Windows y macOS** (CachyOS fuera de alcance)
> Evidencia: documentación oficial actual, más 3 rondas de inspección real en la PC Windows (`orch-inspect/windows.json`, `windows-probe2.json`, `windows-probe3.json`). La Mac todavía **no** fue inspeccionada.

---

## Índice

1. [Objetivo y principios](#1-objetivo-y-principios)
2. [Decisiones tomadas (registro)](#2-decisiones-tomadas-registro)
3. [Entorno verificado](#3-entorno-verificado)
4. [Pruebas realizadas y resultados](#4-pruebas-realizadas-y-resultados)
5. [Capacidades reales por CLI](#5-capacidades-reales-por-cli)
6. [Inventario de modelos](#6-inventario-de-modelos)
7. [Evaluación de modelos (evidencia)](#7-evaluación-de-modelos-evidencia)
8. [Pool permitido](#8-pool-permitido)
9. [Clasificación de tareas y routing](#9-clasificación-de-tareas-y-routing)
10. [Política de effort](#10-política-de-effort)
11. [Política de cuotas](#11-política-de-cuotas)
12. [Arquitectura técnica](#12-arquitectura-técnica)
13. [Runner `orch.mjs`](#13-runner-orchmjs)
14. [Adapters por CLI](#14-adapters-por-cli)
15. [Worker contract, packet y result.json](#15-worker-contract-packet-y-resultjson)
16. [Estados, clasificación de errores y fallback](#16-estados-clasificación-de-errores-y-fallback)
17. [Flujo `implement` de punta a punta](#17-flujo-implement-de-punta-a-punta)
18. [Plantilla de plan.md](#18-plantilla-de-planmd)
19. [Seguridad y git safety](#19-seguridad-y-git-safety)
20. [Auditoría de Opus y repair](#20-auditoría-de-opus-y-repair)
21. [Historial local](#21-historial-local)
22. [Desktop vs CLI · Windows vs macOS](#22-desktop-vs-cli--windows-vs-macos)
23. [Riesgos y mitigaciones](#23-riesgos-y-mitigaciones)
24. [Pendientes que verifica `doctor`](#24-pendientes-que-verifica-doctor)
25. [Fases de implementación y criterios de aceptación](#25-fases-de-implementación-y-criterios-de-aceptación)
26. [Fuera de alcance](#26-fuera-de-alcance)
27. [Fuentes](#27-fuentes)

---

## 1. Objetivo y principios

Claude Code con **Opus 5.5 High** actúa como Tech Lead: arquitecto, planificador, router de modelos y proveedores, supervisor, gestor de cuotas y auditor final. Delegar en los workers (Devin, Codex, Antigravity) es automático: Reed no copia ni pega nada entre aplicaciones.

```
HU / bug / requerimiento
  → Opus analiza el repo y las reglas del proyecto
  → Opus escribe .orchestrator/plans/<id>.md
  → router: candidatos → (harness, modelo, effort) + cuotas → ROUTING DECISION
  → el runner lanza el worker en background
  → el worker implementa TODO el plan, valida y escribe result.json
  → checks deterministas (scope, comentarios, git)
  → Opus audita el diff, el plan y las validaciones → PASS | REPAIR_REQUIRED (máx. 2 ciclos)
```

Principios no negociables:

- **Sin API keys de pago.** Cada CLI usa su propia sesión de suscripción.
- **Sin Python.** El runner es un único archivo Node.js (≥20), sin dependencias, con `child_process.spawn`, `shell:false` y argumentos separados.
- **Sin sobreingeniería.** Nada de LangGraph, CrewAI, bases de datos, colas, daemons, Docker ni gateways.
- **No inventar flags.** Manda la salida real del CLI instalado.
- **Calidad antes que cuota.** Entre opciones de calidad parecida, se prefiere Devin.
- **PLAN_CONTRADICTION nunca dispara fallback.** Siempre vuelve a Opus.
- **Opus 5.5 solo corre en Claude Code.** Nunca se delega en otro harness.
- **Un solo worker escribe por working tree.**
- **Los workers no agregan comentarios al código.**
- **Progressive disclosure.** SKILL.md se mantiene corto y el detalle va en `references/`.

---

## 2. Decisiones tomadas (registro)

| # | Tema | Decisión de Reed |
|---|---|---|
| D1 | Plataformas | Windows y macOS. Sin Linux/CachyOS en v1 |
| D2 | Allowlist de Devin | SWE-2 (todos los efforts), GPT-6.1 Sol (todos), Sonnet 5.5 (todos), Haiku 5.5 (todos), DeepSeek V4.1 Flash (todos). **Fuera:** Fusion, Luna, Gemini, Kimi |
| D3 | Codex | Sin sandbox: `--dangerously-bypass-approvals-and-sandbox` |
| D4 | Permisos de Devin | `smart` por defecto. Un bloqueo inspeccionable, no destructivo y previsto en el plan permite un reintento con allowlist específica. `dangerous` solo por decisión explícita de Reed |
| D5 | Antigravity | Worker **automático**, igual que los demás (pese a que `--sandbox` no limita el workspace en Windows) |
| D6 | Cuota de Devin | Opción **(b)**: endpoint no oficial `GetUserStatus` autorizado, con capas de respaldo |
| D7 | Cuota de Antigravity | UNKNOWN, con fallback reactivo |
| D8 | Reservas semanales | Claude 35% · Codex 20% · Devin 0% · Antigravity 10% |
| D9 | Opus en Devin | No. Opus 5.5 solo en Claude |
| D10 | Reset credits de Codex | Nunca automáticos. Solo los activa Reed |
| D11 | Statusline de Claude | Se prepara el script, pero **no se instala** hasta que Reed lo indique |
| D12 | Ubicación de los planes | `<repo>/.orchestrator/plans/<id>.md` |
| D13 | Repair automático | Máximo 2 ciclos; después se pregunta |
| D14 | Sonnet/Haiku vía Claude CLI | Deshabilitados (se usan vía Devin para no gastar Claude Pro) |
| D15 | Modelos nuevos | Se descubren y muestran, pero nunca se habilitan solos |
| D16 | Implementador general | **Devin / GPT-6.1 Sol / Medium**. SWE-2 queda como especialista en tareas chicas y mecánicas (SMALL_FIX, BUG_SIMPLE, MECHANICAL, TEST_GENERATION) |
| D17 | Bootstrap | En REFACTOR, MIGRATION y FEATURE, las primeras 10 corridas por clase alternan entre Devin Sol Medium y Devin SWE-2 High. Después decide el historial (§9.5) |

---

## 3. Entorno verificado

### 3.1 Windows (inspeccionado el 2026-10-12)

| Ítem | Valor |
|---|---|
| SO | Windows 11 Pro 10.0.26300, x64 |
| Node | v24.18.1 vía nvm4w (`C:\nvm4w\nodejs` es un symlink a `C:\ProgramData\nvm\v24.18.1`) |
| Git | 2.55.0.windows.3, con Git Bash |
| Shells de la sesión de Claude Code | PowerShell 5.1 + Git Bash (herramienta Bash con rutas MSYS) |
| Monitor / Bash en background | Disponibles |

| CLI | Versión | Ruta | Tipo | Auth |
|---|---|---|---|---|
| claude | 2.1.292 | `%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe` | symlink a `.exe` real | OK (`claude auth status`) |
| devin | 3000.11.3 | `%LOCALAPPDATA%\devin\cli\bin\devin.exe` | `.exe` real | OK (`devin auth status`) |
| codex | 0.160.0 | `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` | apunta a `%USERPROFILE%\.codex\packages\standalone\releases\0.160.0-…\codex.exe` | OK (`codex login status`), plan `plus` |
| agy | 1.3.3 | `%LOCALAPPDATA%\agy\bin\agy.exe` | `.exe` real | OK (implícito: el PONG funcionó; no hay comando de status) |

Configuración existente relevante:
- Codex global: `windows.sandbox = "elevated"` y `sandbox_workspace_write.network_access = true`.
- Codex tiene configurado un MCP local en `127.0.0.1:3845` que está caído. Genera ruido `rmcp` en stderr, pero no afecta el JSONL.
- Claude: un `claude -p` gasta unos 31.7k tokens de cache creation por los plugins y hooks locales. No importa, porque Claude no se usa como worker.

### 3.2 macOS
**No inspeccionado.** `doctor` lo valida en la primera corrida (ver §24).

---

## 4. Pruebas realizadas y resultados

### 4.1 Inspección 1: versiones, flags, modelos, cuotas y spawn sin TTY

Spawn con `shell:false`, pipes y sin TTY, en un repo temporal, con el prompt "Reply with the word PONG only":

| CLI | argv | Prompt | Resultado |
|---|---|---|---|
| claude | `claude -p --model haiku --effort low --output-format json --no-session-persistence --permission-mode dontAsk` | stdin | ✅ exit 0, JSON parseable, 6.7 s |
| devin | `devin -p --prompt-file prompt.txt --model claude-haiku-5-5-low --respect-workspace-trust false --permission-mode auto` | archivo | ✅ exit 0, texto plano, 5.2 s |
| codex | `codex exec --json -m gpt-5.6-luna -c model_reasoning_effort="low" -s read-only --skip-git-repo-check --ephemeral -C <dir> -` | stdin | ✅ exit 0, JSONL, 6.7 s (stderr con ruido `rmcp`) |
| agy (intento 1) | `agy -p --model gemini-3.8-flash-low --output-format json` | stdin | ❌ exit 2: `-p` tomó `--model` como prompt. No gastó turno |
| agy (intento 2) | `agy --model gemini-3.8-flash-low --output-format json --print=<prompt>` | argv | ✅ exit 0, JSON, 4.6 s. **Stdout completo sin TTY**: el issue #76 no se reproduce |

Cuotas:
- **Codex:** `codex app-server` por stdio (`initialize`, `initialized`, `account/rateLimits/read`) responde en unos 0.6 s y **no consume turno**. Devuelve `primary` (300 min), `secondary` (10080 min), `credits`, `planType: plus`, `rateLimitResetCredits.availableCount: 3` y `ordinaryUsageAllowed: true`.
- **agy:** `agy -p /usage --output-format json` **no ejecuta el slash command**: se lo manda al modelo como prompt. **Gasta un turno** (~11.7k tokens de entrada), devuelve `response:""` y `denied_actions: RunCommand`. Resultado: UNSUPPORTED_OFFICIALLY en headless.
- **Devin:** ni `auth status`, ni `doctor --json`, ni `models list` traen la cuota. Resultado: UNSUPPORTED_OFFICIALLY.
- **Claude:** el `--help` no menciona la statusline; se probó en la ronda 2.

### 4.2 Probe 2: escritura mínima, sandbox de agy, effort de agy, red de Codex y statusline de Claude

Tarea: "Append the line OK to a.txt, then run `git status --short` and stop."

| Prueba | Resultado |
|---|---|
| Devin con `--permission-mode auto` | ✅ Editó y corrió `git status`. Pero `git status` es solo lectura, así que esto **no prueba** que pueda correr comandos que escriben (ver 4.3) |
| Devin con el prompt por stdin | ❌ exit 1: "Print mode … needs a prompt". **No acepta stdin.** Opciones: `-p "<texto>"`, `-p -- <texto>`, `--prompt-file` |
| agy con `--dangerously-skip-permissions`, sin y con `--sandbox` | ✅ en ambos casos. `--sandbox` se acepta en Windows |
| agy `--model gemini-3.8-flash-high --effort max` | ❌ exit 1, `status:ERROR`, sin gastar turno: "conflicts with --effort=max" |
| agy `--model gemini-3.8-flash --effort max` | ❌ exit 1: "has no "max" effort (available: low, medium, high)" |
| agy `--model gemini-3.8-flash --effort low` | ✅ El evento `init` de stream-json trae `model` (el slug base), `cwd`, `tools` y `permission_mode`. **No informa el effort** |
| Codex `-s workspace-write` | ✅ Edita. Advierte que no puede acceder a `~/.config/git/ignore`: el sandbox restringe lecturas fuera del workspace |
| Codex con red en workspace-write | ❌ **Sin red** (Invoke-WebRequest falla dentro del sandbox y devuelve 200 fuera). `node` no se encuentra |
| Statusline de Claude (sesión interactiva por ConPTY con `--settings` temporal) | ✅ El script recibe JSON por stdin. El primer render **no** trae `rate_limits`; el segundo, **todavía sin ninguna respuesta de la API**, ya trae `rate_limits.five_hour` y `rate_limits.seven_day`, cada uno con `{used_percentage, resets_at}` (epoch en segundos). **Se lee la cuota sin gastar turno**, pero solo en sesiones interactivas |

Efecto secundario: Claude marcó la carpeta temporal como trusted en `~/.claude.json`. Es inofensivo.

### 4.3 Probe 3: comandos reales, límite de workspace de agy y sandbox de Codex

| Prueba | Resultado |
|---|---|
| Devin `auto` con `npm test` + crear `build/out.txt` | ❌ **Bloqueo silencioso:** exit 0, stdout vacío, y en stderr `warning: rejected a tool call that requires confirmation. Running in non-interactive mode. Use --permission-mode dangerous to auto-approve all tools.` No creó nada |
| Devin `accept-edits` | ❌ El mismo bloqueo silencioso |
| Devin `smart` | ✅ `npm test` dio `TEST_OK` y creó `build/out.txt` con `X`. **`smart` es el modo mínimo que completa una tarea real en headless** |
| agy, escritura fuera del workspace, sin `--sandbox` | ⚠️ Escribió `%TEMP%\orch-outside-1.txt` |
| agy, escritura fuera del workspace, con `--sandbox` | ⚠️ **También escribió** `%TEMP%\orch-outside-2.txt`. `--sandbox` no limita el filesystem en Windows |
| Codex `workspace-write`, sandbox `elevated` + `network_access=true` | ❌ No encuentra node ni npm, y no hay red |
| Codex: diagnóstico del PATH | El PATH incluye `C:\nvm4w\nodejs`, pero ese symlink apunta a `C:\ProgramData\nvm\…` y da "Acceso denegado". El problema es de **lectura**, no de PATH |
| Codex `-c windows.sandbox="unelevated"` | ✅ Corren `npm test` y `npm view`, pero npm falla con EPERM al escribir en `%LOCALAPPDATA%\npm-cache` |
| Codex `unelevated` + `writable_roots=['…\npm-cache']` | ✅ `npm test` y `npm view react version` (19.3.0) funcionan |
| Codex `unelevated` + `network_access=false` (control) | ⚠️ **La red sigue abierta.** En modo `unelevated`, `network_access` no se aplica |

Conclusión para Codex: el sandbox de Windows no sirve de forma práctica. Hay que configurarlo a mano y aun así no aísla la red. Por eso Reed decidió **correr sin sandbox** (D3).

---

## 5. Capacidades reales por CLI

| | **claude** 2.1.292 | **devin** 3000.11.3 | **codex** 0.160.0 | **agy** 1.3.3 |
|---|---|---|---|---|
| Rol | **Orquestador** (no es worker) | Worker | Worker | Worker |
| Headless | `-p` | `-p` | `exec` | `-p` / `--print` / `--prompt` |
| Prompt | stdin | **solo** `--prompt-file` o argv | stdin (`-`) | **solo argv**: `--print=<texto>` como último argumento |
| Modelo | `--model` (alias) | `--model <slug>` | `-m <slug>` | `--model <slug base>` |
| Effort | `--effort low…max` | **dentro del slug** (`gpt-6-1-sol-medium`) | `-c model_reasoning_effort="<e>"` | `--effort low/medium/high` (validado por modelo) |
| cwd | cwd del spawn | cwd del spawn | `-C <dir>` | cwd del spawn |
| Permisos | `--permission-mode` | `--permission-mode auto/accept-edits/smart/dangerous` | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` |
| Sandbox | — | `--sandbox` (no se usa) | no se usa (D3) | `--sandbox` (no limita el FS en Windows) |
| Timeout | — | — | — | `--print-timeout` (0 = sin límite) |
| Output estructurado | json, stream-json, `--json-schema` | **solo texto** | `--json` (JSONL), `--output-schema`, `-o` | json, stream-json, `--json-schema` |
| Listar modelos | — (alias) | `devin models list --format json` | `codex debug models` | `agy models` |
| Cuota | statusline `rate_limits` (interactiva) | sin interfaz oficial | `app-server` `account/rateLimits/read` | sin interfaz útil en headless |
| Gotchas | — | **Un permiso denegado da exit 0 con stdout vacío** | ruido en stderr si un MCP está caído; el effort por defecto de Sol es `low` | `-p` se come el siguiente token; un permiso denegado da exit 0 con salida vacía y `denied_actions` |

---

## 6. Inventario de modelos

### 6.1 Devin (`devin models list --format json`: 49 familias y unas 750 variantes)

Relevantes (precio por 1M tokens, input/output, descontado de la cuota de Devin):

| Familia | Slugs | Contexto | Costo |
|---|---|---|---|
| **SWE-2** | `swe-2-medium`, `swe-2-high`, `swe-2-max` | 262K (128K de output) | **Free** |
| **GPT-6.1 Sol** | `gpt-6-1-sol-{low,medium,high,xhigh,max}` (+ `-priority`) | 1M | $2 / $10 (priority: $4/$20) |
| GPT-6 Sol | `gpt-6-sol-{none…max}` | 1M | $2 / $10 |
| GPT-6 Luna | `gpt-6-luna-{none…max}` | 1M | $0.10 / $0.50 |
| GPT-5.6 Terra | `gpt-5-6-terra-{none…max}` | 1M | $2 / $12 |
| GPT-6 Astra | `gpt-6-astra-*` | 1M | caro |
| **Sonnet 5.5** | `claude-sonnet-5-5-{low…max}` | 1M | $2 / $10 |
| **Haiku 5.5** | `claude-haiku-5-5-{low…max}` | 1M | $0.10 / $0.50 |
| Opus 5.5 | `claude-opus-5-5-*` | 1M | $4 / $20 (no se usa, D9) |
| **DeepSeek V4.1 Flash** | `deepseek-v4-1-flash-{high,max}` | ~1M | $0.22 / $0.66 |
| Kimi K2.7 | `kimi-k2-7` (sin effort) | 262K | $0.95 / $4 |
| Kimi K3 | `kimi-k3-{low,high,max}` | ~1M | $3 / $15 |
| Gemini 3.8 Flash | `gemini-3-8-flash-{low,medium,high}` | ~1M | $0.75 / $3.75 |
| SWE-1.7 / SWE-1.6 Fast | `swe-1-7`, `swe-1-6-fast` | 262K / 200K | $0.5 / $2.5 |
| Fusion | 505 combinaciones `fusion-<lead>-sidekick-swe-2-medium` | 1M | precio del lead (el sidekick es gratis) |
| Adaptive | `adaptive` | — | router propio de Devin |
| Otros | Grok 4.5–4.7, Fable 5/5.1, Opus 4.x, GPT-5.x, legacy `MODEL_*` | — | — |

### 6.2 Codex (`codex debug models`)

| Slug | Efforts | Default | Visible | Contexto |
|---|---|---|---|---|
| `gpt-6.1-sol` | low, medium, high, xhigh, max, ultra | **low** | sí | 272K (debug: `max_context_window` 872000) |
| `gpt-6-astra` | low…ultra | low | sí | ídem |
| `gpt-6-sol` | low…ultra | medium | sí | ídem |
| `gpt-6-luna` | low…max | medium | sí | ídem |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | … | … | sí | ídem |
| `gpt-5.5` | low…xhigh | medium | sí (se retira el 14-10-2026) | ídem |
| `gpt-reserve` | low…max | medium | **oculto** | ídem |
| `codex-auto-review` | low…max | medium | interno | ídem |

### 6.3 Antigravity (`agy models`)

`gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-*`, `gemini-3.6-flash-*`, `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.
El effort se pasa con el **slug base + `--effort`**. El máximo real de Gemini 3.8 Flash es **high**.

### 6.4 Claude Code
Alias: `fable`, `opus`, `sonnet`, `haiku`. Effort: low…max. No hay un comando para listar modelos.

---

## 7. Evaluación de modelos (evidencia)

> Advertencia: casi todos los benchmarks están reportados por el propio fabricante, y **el mismo modelo no rinde igual en distintos harness**. Por eso Devin/Sol y Codex/Sol son candidatos separados. Lo que realmente decide es el historial local (§21).

| Modelo | Evidencia clave | Fortalezas | Debilidades | Rol |
|---|---|---|---|---|
| **GPT-6.1 Sol** | DeepSWE 71.9% (BenchLM) a 75.2% (OpenAI, por encima de Astra con 74.8%): **igual o mejor que SWE-2**. Intentó sortear restricciones explícitas en el 23.5% de los casos (GPT-6 Sol: 64.4%; Astra: 17.4%), que es **la única evidencia disponible sobre disciplina de scope**. En coding alcanza su mejor puntaje por debajo del effort máximo. Usa 10–30% más tokens que 6.0. 1M de contexto | Generalista. Disciplina de scope. Builds, nativo móvil, bugs, features | Más lento | **Implementador general (D16)** y todas las clases complejas |
| **SWE-2** (Devin) | DeepSWE 1.1: 73.0%. Terminal-Bench 2.1: 92.8% (benchmark retirado). Terminal-Bench 4: 27.3% (Fable 5.1: 55.8%). En medium, 53 pasos por tarea frente a 127 de SWE-1.7. Post-entrenamiento de Kimi K3. **Todo auto-reportado** por Cognition (FrontierCode es su propio benchmark y reportan el mejor resultado entre efforts). **Sin datos sobre adherencia al plan ni disciplina de scope.** 262K de contexto | Explora poco, rápido, cambios mecánicos y tests. **Free en Devin** (promo), pero esa ventaja pesa poco porque Reed rara vez agota Devin | Tareas largas con shell pesado (Gradle/Xcode), repos grandes | Especialista: SMALL_FIX, BUG_SIMPLE, MECHANICAL, TEST_GENERATION. Alternativa en REFACTOR, MIGRATION y FEATURE (bootstrap) |
| **Sonnet 5.5** (Devin) | Familia Claude: diversidad frente a los modelos GPT | Calidad alta y una "segunda opinión" distinta | Precio de Sol | Alternativa de calidad en clases complejas |
| **Haiku 5.5** (Devin) | Muy barato ($0.10/$0.50) | Fixes chicos y atómicos | Profundidad limitada | Alternativa en SMALL_FIX |
| **DeepSeek V4.1 Flash** (Devin) | AutomationBench 54.8%, Codeforces 3471. Cobertura de benchmarks parcial | Muy barato, 1M de contexto | Sin evidencia sobre adherencia al plan, así que se valida estricto | SMALL_FIX, TEST_GENERATION, MECHANICAL |
| **GPT-6 Luna** (Codex) | DeepSWE 66.6% en max por $0.22 la tarea. AA Coding Index 41 (por debajo de GPT-5.6 Luna) | Volumen, tareas repetitivas, preservar la cuota de Sol | Menor capacidad en tareas largas | Fallback en Codex para tareas chicas y mecánicas |
| **Gemini 3.8 Flash** (agy) | Terminal-Bench 2.1: 90.8%. BenchLM: #6 en coding, #11 en agentic | Pool independiente, rápido | Agentic más débil; sin límite de workspace en Windows | Fallback en todas las clases livianas |
| GPT-5.6 Terra | $2/$12, dominado por Sol 6.1 ($2/$10) en precio y calidad | — | — | **Deshabilitado** |
| Kimi K2.7 | SWE-1.7 se construyó sobre K2.7, y SWE-2 sobre K3 | — | Dominado por SWE-2 | **Fuera** (D2) |
| Fusion Sol 6.1 + SWE-2 | Precio de Sol, sidekick gratis | — | — | **Fuera** (D2) |

---

## 8. Pool permitido

| Harness | Modelo | Efforts permitidos | Pago | Bucket de cuota |
|---|---|---|---|---|
| Devin | SWE-2 | medium, high, max | Devin (Free) | devin |
| Devin | GPT-6.1 Sol | low, medium, high, xhigh, max (**sin** `-priority`) | Devin | devin |
| Devin | Sonnet 5.5 | low…max | Devin | devin |
| Devin | Haiku 5.5 | low…max | Devin | devin |
| Devin | DeepSeek V4.1 Flash | high, max | Devin | devin |
| Codex | GPT-6.1 Sol | low…max (**Ultra prohibido**) | Reed | codex |
| Codex | GPT-6 Luna | low…max | Reed | codex |
| agy | Gemini 3.8 Flash | low, medium, high | Google | antigravity |
| Claude | Opus 5.5 | — | Reed | claude (**solo orquestador**) |

Deshabilitados en el catálogo: todo lo demás. `models refresh` marca los modelos nuevos como `enabled:false, new:true`.

---

## 9. Clasificación de tareas y routing

### 9.1 Clases

| Clase | Cuándo usarla | Duración estimada (para el reset) |
|---|---|---|
| SMALL_FIX | 1–3 archivos, cambio puntual | 15 min |
| BUG_SIMPLE | Causa conocida, fix localizado | 20 min |
| MECHANICAL_CHANGE | Renombres, patrones repetidos, muchos archivos | 30 min |
| TEST_GENERATION | Tests sobre código existente | 30 min |
| REFACTOR | Reestructurar sin cambiar comportamiento | 45 min |
| MIGRATION | Versiones, APIs, esquemas | 60 min |
| FEATURE | Funcionalidad nueva con un plan muy detallado | 60 min |
| CROSS_LAYER_FEATURE | Frontend, backend y datos, con razonamiento residual | 75 min |
| BUG_COMPLEX | Causa incierta, varias capas | 60 min |
| NATIVE_MOBILE | Android/iOS, Gradle, Xcode, módulos nativos de RN | 75 min |
| ARCHITECTURAL_IMPL | Implementa una arquitectura nueva definida por Opus | 90 min |

### 9.2 Tabla de candidatos (en orden de preferencia por calidad)

| Clase | 1ª | 2ª | 3ª | 4ª | 5ª |
|---|---|---|---|---|---|
| SMALL_FIX · BUG_SIMPLE | Devin SWE-2 Medium | Devin DeepSeek High | Devin Haiku 5.5 Medium | agy Gemini High | Codex Luna High |
| MECHANICAL · TEST_GENERATION | Devin SWE-2 High | Devin DeepSeek Max | agy Gemini High | Codex Luna Max | — |
| REFACTOR · MIGRATION | Devin Sol Medium ⇄ | Devin SWE-2 High ⇄ | Codex Sol Medium | — | — |
| FEATURE | Devin Sol Medium ⇄ | Devin SWE-2 High ⇄ | Codex Sol Medium | — | — |
| CROSS_LAYER_FEATURE | Devin Sol Medium | Devin Sonnet 5.5 High | Codex Sol Medium | — | — |
| BUG_COMPLEX | Devin Sol High | Devin Sonnet 5.5 High | Codex Sol High | — | — |
| NATIVE_MOBILE | Devin Sol High | Codex Sol High | Devin Sonnet 5.5 High | — | — |
| ARCHITECTURAL_IMPL | Devin Sol High | Codex Sol High | — | — | — |

⇄ = participan del bootstrap (§9.5). Mientras dura, se alternan; al terminar, el orden lo define el historial.

Implementador por defecto (D16): **Devin / GPT-6.1 Sol / Medium**. SWE-2 es el especialista para tareas chicas y mecánicas, donde la diferencia de calidad no se nota y su eficiencia (pocos pasos) ayuda.

### 9.3 Algoritmo (heurística explicable, sin falsa precisión)

1. **Filtro duro.** El candidato tiene que cumplir todo esto:
   - Está en el pool (§8) y en el catálogo con `enabled:true`.
   - `doctor` encontró el CLI y la autenticación.
   - El effort está en la lista del catálogo.
   - La cuota no está EXHAUSTED.
2. **Orden base:** la tabla de §9.2.
3. **Preferencia de pago.** Solo dentro del mismo "tier de calidad", definido en `routing-policy.md` (por ejemplo, Devin Sol Medium y Codex Sol Medium son el mismo tier): Devin, después agy, después Codex.
4. **Ajuste por cuota.**
   - PROTECTED (bajo la reserva) → baja al final de su tier, salvo que no haya alternativa en el tier, o que Reed lo autorice.
   - CRITICAL con reset en más de 24 h → baja un tier.
   - Si el reset llega antes de la duración estimada de la clase → no se penaliza.
   - UNKNOWN → no se penaliza ni se premia. Se marca "quota unknown" en la decisión.
5. **Bootstrap (§9.5).** Si la clase está en bootstrap, entre los candidatos ⇄ que pasaron los filtros se elige el que tenga **menos corridas** en esa clase (si empatan, Sol).
6. **Ajuste por historial.** Fuera del bootstrap, con 5 corridas o más del candidato en esa clase, si su tasa de `repairRequired + validationFailures` supera en 25 puntos o más al siguiente del tier, baja una posición. La decisión lo explica.
7. **Salida:** el primero de la lista y el **fallback por error de ejecución**, que es el siguiente candidato válido, recalculado en el momento del fallo.

### 9.4 Formato de la decisión (se muestra siempre antes de lanzar)

```
ROUTING DECISION
Task class: CROSS_LAYER_FEATURE
Selected:   Devin / GPT-6.1 Sol / Medium
Reason:     Cross-layer implementation with a very detailed plan. Sol Medium gives strong
            reasoning without overthinking. Devin is preferred over Codex at equal quality.
Quota:      Devin daily HEALTHY (82%, reset 9h) · weekly HEALTHY (77%, reset 4d) [source: unofficial]
History:    6 runs in this class · 1 repair
Fallback if execution failure: Codex / GPT-6.1 Sol / Medium (codex weekly MODERATE 41%)
PLAN_CONTRADICTION fallback: NONE → back to Opus
```

En bootstrap, la línea `Reason` lo indica, por ejemplo: `Bootstrap 4/10 for FEATURE: alternating Devin Sol Medium ⇄ Devin SWE-2 High (Sol 2 runs, SWE-2 2 runs)`.

### 9.5 Bootstrap: comparar Sol y SWE-2 con datos propios

Objetivo: decidir con evidencia de los repos de Reed si SWE-2 High puede reemplazar a Sol Medium en REFACTOR, MIGRATION y FEATURE. Los benchmarks públicos no alcanzan para decidirlo.

- **Clases:** REFACTOR, MIGRATION y FEATURE (configurable en `config.json → bootstrap.classes`).
- **Candidatos:** Devin Sol Medium y Devin SWE-2 High. Los dos usan la cuota de Devin, así que no hay costo extra.
- **Duración:** 10 corridas por clase (`bootstrap.runsPerClass`), es decir, 5 por modelo.
- **Selección:** el candidato con menos corridas en la clase (§9.3, paso 5).
- **Qué se excluye:** las corridas que terminan en PLAN_CONTRADICTION, EXECUTION_FAILURE, QUOTA, RATE_LIMITED o TIMEOUT por causa externa no cuentan como corrida de bootstrap, porque no miden la calidad del modelo.
- **Métricas al terminar:** PASS sin repair, número promedio de repairs, flags de scope y comentarios en el postflight (§19.3), VALIDATION_FAILURE y duración.
- **Decisión:** si SWE-2 iguala o supera a Sol en PASS sin repair y no tiene más flags de scope, sube a 1ª opción en esa clase. Si no, Sol queda 1ª y SWE-2 2ª. El resultado se muestra en `orch history --class <C>` y **se le avisa a Reed antes de cambiar el orden**.
- **Salir antes:** Reed puede cerrar o reiniciar el bootstrap con `orch bootstrap end|reset --class <C>`.
- **Repairs:** se cuentan para el modelo que hizo la corrida original. Un repair siempre lo hace el mismo worker (§20).

---

## 10. Política de effort

Reglas generales:
- **El effort siempre se pasa de forma explícita.** El default de Codex para Sol es `low`.
- Se elige el **mínimo** effort que mantenga la fiabilidad necesaria.
- Los efforts válidos salen **del catálogo**, que se descubre del CLI. Nunca se envía un effort inexistente.
- XHigh/Max de Sol solo con una justificación escrita por Opus en el plan (`effortJustification`).
- **Ultra está prohibido**: lanza subagentes en paralelo y rompe la regla de un solo escritor.

| Modelo | Default | Sube cuando | Nunca |
|---|---|---|---|
| GPT-6.1 Sol | medium | high: BUG_COMPLEX, NATIVE, ARCH, o un repair por razonamiento insuficiente. xhigh/max: solo justificado | ultra |
| SWE-2 | medium en SMALL_FIX/BUG_SIMPLE; high en MECHANICAL, TEST_GENERATION y en el bootstrap | max: MECHANICAL de más de 50 archivos, solo si el historial muestra que max rinde mejor | — |
| DeepSeek V4.1 Flash | high | max: TEST_GENERATION y MECHANICAL | — |
| Sonnet 5.5 | medium | high: clases complejas | max sin justificación |
| Haiku 5.5 | medium | high: si medium falló una vez | — |
| GPT-6 Luna | high | max: TEST_GENERATION y MECHANICAL | ultra (no lo soporta) |
| Gemini 3.8 Flash | high (máximo real) | — | xhigh/max (el CLI los rechaza) |

Cómo se traduce el effort en cada adapter:
- Devin: `<familia>-<effort>`, por ejemplo `gpt-6-1-sol-medium` o `swe-2-high`.
- Codex: `-c model_reasoning_effort="medium"`.
- agy: `--model gemini-3.8-flash --effort high`.

---

## 11. Política de cuotas

### 11.1 Modelo normalizado

```json
{
  "provider": "codex",
  "available": true,
  "source": "official|unofficial|statusline|manual|reactive|none",
  "retrievedAt": "2026-10-12T17:00:00Z",
  "freshness": "LIVE|STALE|UNAVAILABLE|UNKNOWN",
  "health": "HEALTHY|MODERATE|LOW|CRITICAL|EXHAUSTED|PROTECTED|UNKNOWN",
  "windows": {
    "short":  { "remainingPercent": 71, "usedPercent": 29, "resetsAt": "…", "resetInSeconds": 7920 },
    "daily":  "UNKNOWN",
    "weekly": { "remainingPercent": 43, "usedPercent": 57, "resetsAt": "…", "resetInSeconds": 259200 }
  }
}
```

**UNKNOWN nunca se trata como 100%.**

### 11.2 Umbrales (configurables en `config.json`)

| Estado | % restante |
|---|---|
| HEALTHY | > 50 |
| MODERATE | 25–50 |
| LOW | 10–25 |
| CRITICAL | < 10 |
| EXHAUSTED | 0, o el provider reporta el límite |
| PROTECTED | por debajo de la reserva semanal (§2, D8) |

**Health del provider** = la peor ventana, ajustada por reset:
- Si el reset llega antes de la duración estimada de la tarea: sube un nivel.
- Si la ventana es semanal y faltan más de 3 días para el reset: baja un nivel.

### 11.3 Cache y refresh
- TTL de **10 minutos** (`quota-cache.json`).
- Refresh obligatorio:
  - antes de una tarea FEATURE o de mayor tamaño;
  - si la cache está stale;
  - después de un RATE_LIMITED o un QUOTA_EXHAUSTED.
- Consultar la cuota nunca usa un LLM.

### 11.4 Fuentes por provider

| Provider | Fuente | Detalle |
|---|---|---|
| **Claude** | `statusline.mjs`, que escribe `~/.claude/orchestrator/claude-usage.json` en cada render | Se instala **solo cuando Reed lo autorice** (D11). Mientras tanto: UNKNOWN. Si ya existe una statusline, se envuelve: el script la ejecuta y además escribe el archivo. En Desktop queda STALE (el último dato capturado). Política: si está LOW o peor, **avisar** y nunca reemplazar a Opus |
| **Codex** | `codex app-server` por stdio: `initialize` → `initialized` → `account/rateLimits/read` | `primary` es la ventana short (300 min) y `secondary` la weekly (10080 min). `usedPercent` y `resetsAt` vienen en epoch de segundos. **Nunca** se usan `rateLimitResetCredits` (D10). No se muestran `accountId` ni el email |
| **Devin** | Capa 1: endpoint no oficial `GetUserStatus` (D6) | Se lee `windsurf_api_key` y `api_server_url` del archivo de credenciales de Devin (en Unix, `~/.local/share/devin/credentials.toml`; la ruta de Windows la descubre `doctor`). La key **solo vive en memoria**: nunca se loguea, se cachea ni se imprime. Solo se guardan los porcentajes y los resets. `source: "unofficial"`. La llamada se replica en Node a partir del código del paquete `devin-cli-usage` (referencia), sin depender de Python |
| | Capa 2: reactiva | Errores de cuota o de rate limit del CLI, clasificados según §16 |
| | Capa 3: contabilidad local | Corridas, modelo, duración y costo de Devin por día y semana, en `history.json` |
| | Capa 4: manual | `orch quota set devin daily=80 weekly=60`, que queda STALE con timestamp |
| **Antigravity** | Ninguna (D7) | UNKNOWN. Solo reactiva. `/usage` en headless **gasta un turno** y no devuelve la cuota |

### 11.5 Reservas (D8)
`claude 35 · codex 20 · devin 0 · antigravity 10`, en porcentaje semanal. Un provider PROTECTED solo se usa si:
- es claramente mejor;
- no hay una alternativa razonable;
- o Reed lo autoriza.

### 11.6 Dashboard (`/orchestrator quota`)

```
CLAUDE        source: statusline      freshness: LIVE
  5h        71% remaining   reset 2h12m   HEALTHY
  weekly    43% remaining   reset 3d      MODERATE (reserve 35%)
DEVIN         source: unofficial      freshness: LIVE
  daily     97% remaining   reset 11h     HEALTHY
  weekly    91% remaining   reset 6d      HEALTHY
CODEX         source: official        freshness: LIVE
  5h        48% remaining   reset 3h      MODERATE
  weekly    29% remaining   reset 4d      MODERATE (reserve 20%)
ANTIGRAVITY   source: none            freshness: UNKNOWN
  —         UNKNOWN (reactive only)
```

Nunca se muestran emails, tokens, cookies, API keys ni IDs de cuenta.

---

## 12. Arquitectura técnica

### 12.1 Árbol de archivos

```
~/.claude/skills/orchestrator/            (la skill, versionada con git)
├── SKILL.md                               flujo + reglas duras (≤250 líneas)
├── references/
│   ├── routing-policy.md                  clases, tabla §9.2, tiers, algoritmo §9.3
│   ├── effort-policy.md                   §10
│   ├── worker-contract.md                 plantilla del packet + reglas + schema de result.json
│   ├── quota-policy.md                    §11
│   ├── plan-template.md                   §18
│   ├── audit-checklist.md                 §20
│   └── cli-adapters.md                    §14 con las versiones verificadas
├── scripts/
│   ├── orch.mjs                           punto de entrada (subcomandos)
│   ├── lib/
│   │   ├── platform.mjs                   rutas, os.homedir, resolución de ejecutables
│   │   ├── proc.mjs                       spawn, background, kill del árbol, timeouts
│   │   ├── config.mjs                     carga y validación de config/catalog/state
│   │   ├── catalog.mjs                    descubrimiento de modelos por CLI
│   │   ├── quota/{codex,claude,devin,agy,normalize}.mjs
│   │   ├── router.mjs                     §9.3
│   │   ├── adapters/{devin,codex,agy}.mjs §14
│   │   ├── packet.mjs                     renderizado del packet
│   │   ├── classify.mjs                   §16
│   │   ├── safety.mjs                     preflight, snapshot, lock, postflight, comment-scan
│   │   ├── validate.mjs                   baseline y re-validación
│   │   └── history.mjs                    §21
│   ├── statusline.mjs                     preparado, NO instalado (D11)
│   └── test/*.test.mjs                    node:test
└── config.defaults.json                   valores por defecto (se copian a ~/.claude/orchestrator la primera vez)

~/.claude/orchestrator/                    (estado de Reed; las actualizaciones de la skill no lo pisan)
├── config.json
├── catalog.json
├── quota-cache.json
├── claude-usage.json
└── history.json

<repo>/.orchestrator/                      (se agrega a .git/info/exclude; no toca tu .gitignore)
├── plans/<id>.md
├── lock                                   un solo escritor
└── runs/<id>/
    ├── packet.md            prompt para el worker
    ├── repair-<n>.md        repair packets
    ├── continuation-<n>.md  continuation packets
    ├── result.json          lo escribe el worker
    ├── snapshot.json        HEAD, branch, stash hash, untracked, baseline de validación
    ├── status.json          estado del proceso (para wait/status)
    ├── events.jsonl         eventos del runner
    ├── stdout.log / stderr.log
    └── audit.md             veredicto de Opus
```

### 12.2 `config.json` (esquema)

```json
{
  "version": 1,
  "platformOverrides": { "paths": { "devin": null, "codex": null, "agy": null, "claude": null } },
  "thresholds": { "healthy": 50, "moderate": 25, "low": 10 },
  "reserves": { "claude": 35, "codex": 20, "devin": 0, "antigravity": 10 },
  "quotaTtlSeconds": 600,
  "repairMaxCycles": 2,
  "bootstrap": {
    "enabled": true,
    "classes": ["REFACTOR", "MIGRATION", "FEATURE"],
    "candidates": ["devin/gpt-6-1-sol@medium", "devin/swe-2@high"],
    "runsPerClass": 10,
    "askBeforeReorder": true
  },
  "timeouts": {
    "SMALL_FIX": 20, "BUG_SIMPLE": 25, "MECHANICAL_CHANGE": 40, "TEST_GENERATION": 40,
    "REFACTOR": 60, "MIGRATION": 90, "FEATURE": 75, "CROSS_LAYER_FEATURE": 90,
    "BUG_COMPLEX": 75, "NATIVE_MOBILE": 90, "ARCHITECTURAL_IMPL": 120,
    "idleMinutes": 15
  },
  "permissions": {
    "devin": { "default": "smart", "retryOnBlock": "allowlist" },
    "codex": { "bypassSandbox": true },
    "agy":   { "skipPermissions": true, "auto": true }
  },
  "quotaSources": { "devinUnofficial": true, "claudeStatusline": false },
  "neverUseCodexResetCredits": true,
  "forbiddenCommands": ["git commit", "git push", "git merge", "git rebase", "git reset --hard",
    "git clean", "git branch -D", "git checkout -- .", "git stash drop", "npm publish",
    "rm -rf /", "Remove-Item -Recurse C:\\"]
}
```

### 12.3 Entrada de `catalog.json`

```json
{
  "id": "devin/gpt-6-1-sol",
  "provider": "openai",
  "harness": "devin",
  "displayName": "GPT-6.1 Sol",
  "slugTemplate": "gpt-6-1-sol-{effort}",
  "efforts": ["low", "medium", "high", "xhigh", "max"],
  "allowedEfforts": ["low", "medium", "high", "xhigh", "max"],
  "defaultEffort": "medium",
  "contextWindow": 1000000,
  "costTier": "$2/$10",
  "quotaBucket": "devin",
  "recommendedRoles": ["CROSS_LAYER_FEATURE", "BUG_COMPLEX", "NATIVE_MOBILE", "ARCHITECTURAL_IMPL"],
  "strengths": ["scope discipline", "builds", "multi-layer reasoning"],
  "weaknesses": ["slower", "more output tokens than 6.0"],
  "enabled": true,
  "new": false,
  "lastValidated": "2026-10-12"
}
```

---

## 13. Runner `orch.mjs`

### 13.1 Subcomandos

| Comando | Qué hace | Salida |
|---|---|---|
| `doctor` | SO, arquitectura, sesión (local, cloud o Desktop), Node, Git, CLIs (ruta real, versión, auth), headless, output, catálogo, interfaces de cuota, pendientes de §24 | Tabla + JSON (`--json`) |
| `models [refresh]` | Muestra el catálogo; `refresh` vuelve a descubrir y marca los modelos nuevos sin habilitarlos | Tabla |
| `models enable/disable <id> [efforts]` | Edita la allowlist | — |
| `quota [refresh] [--json]` | Dashboard §11.6 | Tabla o JSON |
| `quota set devin daily=N weekly=N` | Capa manual | — |
| `route --class <C> [--files N] [--explain]` | Decisión §9.4 sin lanzar nada | Bloque + JSON |
| `preflight --plan <path>` | git status, lock, snapshot, `.git/info/exclude`, baseline de validación | JSON |
| `run --plan <path> --class <C> [--harness h --model m --effort e] [--repair n] [--continuation n]` | Arma el packet, lanza en background y devuelve el `runId` | JSON |
| `status <runId>` / `wait <runId> [--timeout s]` | Estado o espera bloqueante con heartbeat | JSON |
| `postflight <runId>` | Checks deterministas §19.3, re-validación y clasificación §16 | JSON |
| `history [--class C]` | Resumen del historial y estado del bootstrap | Tabla |
| `bootstrap status\|end\|reset [--class C]` | Ver, cerrar o reiniciar el bootstrap (§9.5) | Tabla |
| `unlock` | Libera un lock huérfano (pide confirmación) | — |

Todos los comandos responden con `--json` para que Opus los consuma.

### 13.2 Ejecución de procesos
- Las rutas se resuelven con `platform.mjs`, en este orden: override en config, `where`/`which` y finalmente el ejecutable real. No hace falta una shell porque todos son `.exe` o binarios reales; si alguna vez aparece un `.cmd`, se resuelve el ejecutable real o se usa `cmd.exe /d /s /c` solo con argumentos internos, nunca con texto del usuario.
- `spawn(exe, args, { shell:false, cwd: repo, windowsHide:true, detached:true, stdio:[pipe|ignore, fd, fd] })`. Stdout y stderr se escriben a archivos.
- Cómo viaja el prompt:
  - codex: stdin;
  - devin: `--prompt-file`;
  - agy: `--print=<instrucción corta que apunta al packet>` como último argumento.
- El proceso hijo hereda el entorno **sin** variables `CLAUDE*` de la sesión padre.
- `status.json` se actualiza al iniciar, cada 30 s y al terminar.
- Timeouts:
  - wall-clock por clase de tarea;
  - **idle** para Codex (JSONL) y agy (con `stream-json` para tener eventos);
  - para Devin, que solo emite texto al final, la señal de vida es la actividad en el working tree (mtimes).
- Al vencer cualquiera de los dos: se mata el árbol de procesos (`taskkill /PID <pid> /T /F` en Windows; `process.kill(-pgid)` en macOS) y se marca TIMEOUT.
- **Espera:** Opus usa Monitor sobre `status.json`, o `orch wait` si no hay Monitor. Nunca deja una llamada Bash bloqueada más allá del timeout de la herramienta.

---

## 14. Adapters por CLI

### 14.1 Devin

```
devin -p --prompt-file <run>/packet.md
      --model <slug-con-effort>
      --respect-workspace-trust false
      --permission-mode smart
      --export <run>/devin-session.json
cwd = <repo>
```

Resultado:
- Stdout es texto libre. El resultado semántico sale de `result.json`, que escribe el worker según el contrato.
- **Detección de bloqueo:** exit 0 + stdout vacío (o casi) + stderr con `rejected a tool call that requires confirmation` = **PERMISSION_FAILURE**.

Reintento con allowlist (D4):
- Se inspeccionan las llamadas bloqueadas del export. Solo comandos previstos en el plan y no destructivos permiten `orch run --allow-from <runId>`, con reglas `Exec(...)` específicas.
- Si ya hay cambios, se añade un continuation packet. Un segundo bloqueo, un comando fuera del plan o una llamada no inspeccionable devuelve `stop-reed`.
- Nunca se escala automáticamente a `dangerous`; Reed decide esa opción. La configuración local de Devin se restaura al terminar la corrida.

Errores de cuota, rate limit y modelo no disponible: los patrones de stderr se definen en `classify.mjs`. **Hay que capturarlos la primera vez que ocurran** (ver §24), y mientras tanto se usa un patrón genérico. Si el exit code es distinto de 0 y no hay `result.json`, se clasifica EXECUTION_FAILURE o UNKNOWN_FAILURE.

### 14.2 Codex

```
codex exec --json
      -m <slug>
      -c model_reasoning_effort="<effort>"
      --dangerously-bypass-approvals-and-sandbox      (D3)
      -C <repo>
      -
stdin = packet.md
```

Resultado:
- Stdout es JSONL: `thread.started` (guardar `thread_id`), `turn.*` e `item.*`.
- Los errores salen de los eventos de error y del exit code.
- **Stderr se ignora si exit=0** (ruido `rmcp`).

Repair: si `doctor` confirma que funciona, se usa `codex exec resume <thread_id>` con el repair packet por stdin; si no, una corrida nueva.
Nunca: `--ephemeral` en implementaciones reales (impediría el resume) ni efforts `ultra`.

### 14.3 Antigravity

```
agy --model gemini-3.8-flash --effort high
    --dangerously-skip-permissions
    --output-format stream-json
    --print-timeout 0
    --print=Read and follow the implementation packet at <abs path to packet.md>. Do not ask questions.
cwd = <repo>
```

Resultado:
- Se parsea el evento `result`: `status`, `error`, `usage` y `denied_actions`.
- `status != SUCCESS` → se clasifica según `error`.
- `denied_actions` no vacío → PERMISSION_FAILURE.
- El `--print=` va **siempre al final** (si `-p` se separa del valor, se come el siguiente token).
- Riesgo aceptado (D5): **sin límite de workspace**. La única defensa es el contrato más los checks de §19.3.

### 14.4 Claude (no es worker)
Solo se usa para el statusline. No se lanzan `claude -p` desde el runner.

---

## 15. Worker contract, packet y result.json

### 15.1 Contrato (va en TODOS los packets)

1. Lee **completo** el plan en `PLAN_PATH`.
2. Inspecciona el repo antes de editar.
3. Implementa **todo** el plan y **solo** el plan, en una sola ejecución, sin pedir confirmación.
4. No rediseñes, no cambies la arquitectura, ni librerías, ni tooling, ni dependencias (salvo que el plan lo indique).
5. **NO_COMMENTS:**
   - No agregues comentarios de ningún tipo: `//`, `/* */`, JSDoc, docstrings, TODO, FIXME ni narrativos.
   - No borres comentarios existentes solo por esta regla. Si uno queda incorrecto por tu cambio, actualízalo o elimínalo.
   - Si el plan exige documentación inline, **detente** y reporta PLAN_CONTRADICTION.
6. **SCOPE:** sin mejoras no pedidas, sin refactors fuera del scope, sin formateo global, sin documentación extra y sin tocar archivos no relacionados. "Podría mejorarlo" no es motivo para hacerlo.
7. **CONTRADICTION:** si el plan contradice objetivamente al repo, **DETENTE**, no improvises y escribe `PLAN_CONTRADICTION` con toda la evidencia.
8. **VALIDATION:** corre los comandos de la sección "Validation" del plan. Distingue las fallas que ya estaban (baseline incluido en el packet) de las que introdujiste.
9. **GIT:** sin commit, push, merge, rebase, `reset --hard`, `clean`, borrar branches ni stash. No toques cambios que no son de esta tarea.
10. **FORBIDDEN_COMMANDS:** la lista de `config.json`.
11. Trabaja solo dentro de `WORKSPACE`. Nunca escribas fuera.
12. Al terminar (o al detenerte), escribe `RESULT_PATH` con el schema de §15.3. Es obligatorio.

### 15.2 Plantilla del packet (`packet.md`)

```markdown
# IMPLEMENTATION PACKET <runId>
PROJECT: <nombre> · <stack detectado>
TASK: <título> · CLASS: <clase>
PLAN_PATH: <ruta absoluta a .orchestrator/plans/<id>.md>
WORKSPACE: <ruta absoluta del repo>
RESULT_PATH: <ruta absoluta a .orchestrator/runs/<runId>/result.json>
PROJECT_RULES: <extracto relevante de CLAUDE.md / AGENTS.md / skills locales>
BASELINE: <comandos de validación y fallas preexistentes>
NO_COMMENTS_POLICY: …
SCOPE_POLICY: …
CONTRADICTION_POLICY: …
VALIDATION_POLICY: …
GIT_POLICY: …
FORBIDDEN_COMMANDS: …
EXPECTED_OUTPUT: write RESULT_PATH following the schema below, then stop.
<schema de result.json>
```

El plan **no se copia** en el packet; solo se pasa la ruta.

### 15.3 `result.json` (schema)

```json
{
  "status": "SUCCESS | PLAN_CONTRADICTION | VALIDATION_FAILURE | EXECUTION_FAILURE",
  "summary": "string",
  "modifiedFiles": [{ "path": "src/x.ts", "change": "modified|added|deleted" }],
  "planStepsCompleted": ["1", "2", "3a"],
  "validation": [{ "command": "npm run typecheck", "result": "pass|fail|skipped", "baselineFailed": false, "notes": "" }],
  "planContradiction": {
    "section": "Paso 3", "planAssumption": "…", "reality": "…",
    "files": ["…"], "symbols": ["…"], "lines": ["src/a.ts:42"],
    "evidence": "…", "impact": "…", "affectedSteps": ["4", "5"],
    "changesMadeBefore": ["…"]
  },
  "errors": ["…"]
}
```

El runner valida el schema. Si falta o es inválido, se cruza con el exit code y el diff y se clasifica según §16.

---

## 16. Estados, clasificación de errores y fallback

| Estado | Quién lo determina | Señales | ¿Fallback? |
|---|---|---|---|
| SUCCESS | worker + runner | `result.json` con SUCCESS, exit 0, finalización del harness y postflight OK | — (pasa a la auditoría) |
| PLAN_CONTRADICTION | worker | `status` + `planContradiction` | **NUNCA.** STOP y vuelve a Opus |
| VALIDATION_FAILURE | worker o runner | regresiones frente al baseline | No: repair con el mismo worker |
| EXECUTION_FAILURE | runner | exit ≠ 0, crash, sin `result.json` | Sí |
| QUOTA_EXHAUSTED | runner | patrones de cuota (Codex: rateLimits; Devin y agy: stderr o `error`) | Sí, y refresh de la cuota |
| RATE_LIMITED | runner | 429 o patrones de rate limit | Sí: espera corta + reintento una vez; después fallback |
| MODEL_UNAVAILABLE | runner | modelo inválido o no disponible (agy da un error explícito) | Sí |
| PROVIDER_UNAVAILABLE | runner | red o auth caídas | Sí |
| PERMISSION_FAILURE | runner | Devin: export y `rejected a tool call`; agy: `denied_actions` | Devin: allowlist específica o `stop-reed` (D4); otros: fallback/continuation según cambios |
| TIMEOUT | runner | wall-clock o idle | Sí, con continuation si hubo cambios |
| UNKNOWN_FAILURE | runner | nada de lo anterior | Se pregunta a Reed |

**Antes y durante el trabajo:** cada estado de fallback lleva el sufijo `_BEFORE_WORK` (sin diff frente al snapshot) o `_DURING_WORK` (con diff).
- **BEFORE_WORK:** fallback directo al siguiente candidato (recalculado con §9.3).
- **DURING_WORK:** Opus inspecciona `git status`, el diff y `result.json` (si existe), y arma un **continuation packet** con: qué se hizo, qué falta (pasos del plan), qué tests pasaron y fallaron, y dónde continuar. Nunca se reinicia la implementación a ciegas.

---

## 17. Flujo `implement` de punta a punta

```
/orchestrator implement "<HU/bug>"
```

1. **Doctor rápido** (con cache de 24 h): ¿sesión local?, ¿CLIs disponibles? Si no, se aborta.
2. **Entender.** Opus lee el requerimiento.
3. **Reglas del proyecto.** Se cargan CLAUDE.md, AGENTS.md, `.claude/skills` del repo y README, **solo** lo relevante.
4. **Inspección del repo.** Arquitectura, patrones y comandos reales de validación (package.json, Gradle, Xcode, Makefile, CI).
5. **Plan.** Opus escribe `.orchestrator/plans/<id>.md` según §18.
6. **Clasificación** de la tarea (§9.1) y estimación de archivos.
7. **Cuota.** `orch quota refresh` si la tarea es FEATURE o mayor, o si la cache está stale. Si Claude está LOW, se **avisa** a Reed.
8. **Routing.** `orch route` y se muestra la ROUTING DECISION.
9. **Preflight.** `git status`:
   - si hay cambios ajenos, se muestran y se pide **confirmación**;
   - lock + snapshot + `.git/info/exclude`;
   - **baseline de validación** (corre los comandos del plan y guarda qué fallaba antes).
10. **Lanzamiento.** `orch run` en background; Opus espera con Monitor.
11. **Postflight.** `orch postflight`: checks de §19.3, re-validación y clasificación de §16.
12. **Según el estado:**
    - PLAN_CONTRADICTION → Opus revisa repo + plan + evidencia, ajusta el plan o pregunta a Reed. Nunca hay fallback.
    - Fallo de ejecución → fallback según §16.
    - SUCCESS o VALIDATION_FAILURE → auditoría (§20).
13. **Auditoría:** PASS, o REPAIR_REQUIRED con un máximo de 2 ciclos.
14. **Cierre.** Resumen para Reed: veredicto, archivos tocados, validaciones, routing usado, cuota consumida y pendientes. Se libera el lock y se registra el historial. **No hay commit.**

Sin `implement`: `route` solo explica la decisión, y `quota`, `models` y `doctor` solo informan.

---

## 18. Plantilla de plan.md

```markdown
# Plan <id>: <título>
Class: <clase> · Estimated files: <n> · Effort justification: <si aplica>

## Context
Requerimiento, criterios de aceptación y reglas del proyecto relevantes.

## Current state (verified)
Archivos, símbolos y patrones existentes, con rutas y líneas. Esta es la base para detectar contradicciones.

## Architecture decisions
Qué se hace y por qué, qué NO se hace y las alternativas descartadas.

## Scope
- In scope: lista exacta de archivos a crear o modificar.
- Out of scope: lo que no se toca.

## Steps
1. <paso atómico> · files · symbols · expected result
2. …

## Naming & patterns to follow
## Data / API contracts
## Edge cases
## Validation
- Commands: <comandos reales descubiertos>
- Baseline: <se completa en el preflight>
- Done when: <criterios verificables>

## Risks
```

---

## 19. Seguridad y git safety

Contexto: los valores predeterminados omiten el sandbox de Codex (D3) y los permisos de agy (D5). Devin usa `smart` y solo pasa a `dangerous` por decisión explícita de Reed (D4). La defensa es la suma de capas. `permissions.codex.bypassSandbox: false` fuerza `workspace-write`; `permissions.agy.skipPermissions: false` omite su flag de bypass.

### 19.1 Preflight
- `git status --porcelain`. Si hay cambios del usuario, se muestran y se pide confirmación antes de delegar.
- Se verifica que no haya un rebase o merge en curso.
- **Lock** `.orchestrator/lock` con PID, runId y timestamp: un solo escritor.
- **Snapshot:** HEAD, branch, `git stash create` (hash de respaldo **sin tocar el working tree**), hashes de archivos dirty, copia de untracked hasta 5 MiB por archivo y 50 MiB en total (se listan los omitidos), y hash de lockfiles y manifests.
- `.orchestrator/` se agrega a `.git/info/exclude`.

### 19.2 Durante la ejecución
- El contrato incluye la lista de comandos prohibidos.
- Timeouts por clase e idle; al vencer, se mata el árbol de procesos.

### 19.3 Postflight: checks deterministas

| Check | Si falla |
|---|---|
| HEAD, branch y stash list sin cambios; sin commits nuevos | **Violación grave.** STOP; se informa con el hash del snapshot para recuperar |
| Archivos fuera de "In scope" del plan | Se marca para la auditoría (no falla solo) |
| Archivos borrados que no estaban en el plan | Violación grave |
| Lockfiles o manifests cambiados sin que el plan lo pida | Violación |
| **Comentarios nuevos** en líneas `+` (`//`, `/*`, `*`, `#` en lenguajes con `#`, `<!--`, `"""`, `TODO`, `FIXME`) | Se marca. Opus decide (puede ser un falso positivo, por ejemplo strings) |
| Formateo masivo (más de N líneas cambiadas solo en whitespace) | Se marca |
| Archivos nuevos fuera del repo | No se detectan en general. **Riesgo residual aceptado** |

### 19.4 Recuperación
Nunca se hace nada automático y destructivo. Si hay una violación grave, se le muestra a Reed el comando exacto para recuperar desde el snapshot, y **él decide**.

---

## 20. Auditoría de Opus y repair

Opus **no confía** en el resumen del worker. Revisa:
1. `git status` y `git diff` frente al snapshot.
2. Cada paso del plan: ¿está implementado?, ¿con los nombres y patrones indicados?
3. Los checks de §19.3.
4. La re-validación frente al baseline: regresiones, sí o no.
5. Los archivos modificados completos cuando sea necesario, no solo el diff.

Veredicto:
- **PASS.**
- **REPAIR_REQUIRED.** Se arma un **repair packet pequeño**: solo los puntos fallidos, con evidencia (archivo, línea, qué falta o sobra), los comandos que tienen que pasar y el mismo contrato. Sin rehacer el plan.
  - Va al **mismo worker** (harness, modelo y effort; Codex con `exec resume` si es posible).
  - **Máximo 2 ciclos** (D13). Después se detiene y le presenta a Reed el estado y las opciones.

El veredicto queda en `runs/<id>/audit.md`.

---

## 21. Historial local

`~/.claude/orchestrator/history.json`, agregado por la clave `harness/model/effort/taskClass`:

```json
{ "devin/gpt-6-1-sol/medium/CROSS_LAYER_FEATURE": {
    "runs": 6, "success": 5, "repairRequired": 1, "planContradictions": 0,
    "executionFailures": 0, "validationFailures": 1, "permissionRetries": 1,
    "avgRepairCount": 0.17, "avgDurationMin": 23, "lastRun": "2026-10-12" } }
```

Además, la **contabilidad de Devin** por día y semana (corridas y duración por modelo) para la capa 3 de cuota.
**Nunca se guardan** prompts, código, rutas absolutas del usuario ni secretos.

---

## 22. Desktop vs CLI · Windows vs macOS

### 22.1 Desktop vs CLI

| Aspecto | CLI | Desktop (sesión Local) | Cloud / Cowork |
|---|---|---|---|
| Carga `~/.claude/skills` | ✅ | ✅ | ❌ (no puede lanzar workers: `doctor` aborta) |
| Bash y procesos locales | ✅ | ✅ | ❌ |
| Monitor | ✅ (verificado) | por verificar (§24) | — |
| Cuota de Claude vía statusline | ✅ (cuando se instale) | probablemente no corre, así que queda STALE o UNKNOWN | — |
| PATH | el de la terminal | macOS: lo lee del perfil de shell; Windows: variables de usuario y del sistema | — |

Como el PATH de Desktop puede diferir, `config.json` admite rutas absolutas por CLI.

### 22.2 Windows vs macOS

| Aspecto | Windows (verificado) | macOS (lo verifica `doctor`) |
|---|---|---|
| Ejecutables | `.exe` reales: `spawn` con `shell:false` funciona | binarios o symlinks |
| Kill del árbol de procesos | `taskkill /T /F` | grupo de procesos (`detached` + `kill(-pgid)`) |
| Credenciales de Devin (cuota) | ruta por descubrir | `~/.local/share/devin/credentials.toml` o `XDG_DATA_HOME` |
| Config de Devin | `%APPDATA%\devin\config.json` | `~/.config/devin/config.json` |
| Codex | sin sandbox (D3) | sin sandbox (D3) |
| agy `--sandbox` | no limita el filesystem | por verificar (no cambia nada: se ejecuta igual por D5) |
| Rutas | siempre `os.homedir()`, `path.join()` y `process.platform`; nunca `C:\Users\X` ni `/Users/X` fijos | ídem |

---

## 23. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Workers sin sandbox (Codex, Devin `dangerous`, agy) | Cambios destructivos o fuera del repo | Contrato, comandos prohibidos, snapshot, checks de §19.3, auditoría de Opus. **Riesgo residual aceptado** |
| Devin bloquea en silencio (exit 0) | Falso éxito | Detección explícita (§14.1) + `result.json` obligatorio |
| Endpoint no oficial de Devin | Puede romperse o cambiar, y no es una API oficial | Solo lectura, key en memoria; si falla, capas 2 a 4; `doctor` lo prueba |
| SWE-2 "Free" es una promo | Cambia poco: el routing ya no depende de eso (D16) | `cost_tier` se lee en cada `models refresh` y la decisión lo refleja |
| Benchmarks auto-reportados (sobre todo SWE-2) | Malas elecciones | Sol como default (D16), bootstrap con datos propios (§9.5) e historial local (§21) |
| El bootstrap usa un modelo peor en tareas reales | Algunos repairs extra durante 10 corridas por clase | Solo en clases medianas, con auditoría de Opus y repair; máximo 5 corridas por modelo |
| Opus agota Claude Pro | Se queda sin orquestador | Checks deterministas en el runner, diff leído por partes, aviso si queda LOW |
| Los CLIs cambian de flags | Rompe los adapters | `cli-adapters.md` versionado, `doctor` compara versiones y avisa |
| Contexto de 262K en SWE-2 | Repos grandes | El plan pasa rutas exactas; si la tarea lo excede, el routing prefiere Sol (1M) |
| `gpt-5.5` se retira el 14-10 | — | No está en el pool |

---

## 24. Pendientes que verifica `doctor`

| # | Qué | Cómo | Si falla |
|---|---|---|---|
| P1 | ¿`devin -p "/usage"` y `/session-stats` los resuelve el CLI sin gastar turno? | `doctor --probe` con prompt-file `/usage` | Se ignora (ya está la capa unofficial) |
| P2 | Ruta de las credenciales de Devin en Windows y en macOS | Búsqueda en `XDG_DATA_HOME`, `~/.local/share/devin`, `%APPDATA%`, `%LOCALAPPDATA%\devin` | Cuota de Devin por capas 2 a 4 |
| P3 | Forma de la llamada `GetUserStatus` | Replicar a partir del código fuente de `devin-cli-usage` y probar | Capas 2 a 4 |
| P4 | ¿`codex exec resume <thread_id>` funciona con stdin? | prueba PONG | Repair con corrida nueva |
| P5 | ¿Hay Monitor en Desktop? | detección de herramientas en SKILL.md | `orch wait` |
| P6 | Patrones de stderr de Devin para cuota, rate limit y modelo no disponible | Se registran en la primera aparición | Patrón genérico → UNKNOWN_FAILURE |
| P7 | macOS completo: versiones, rutas, spawn, permisos y cuotas | Correr la inspección 1 + probes 2 y 3 en la Mac | Se marca el harness como no disponible en Mac |
| P8 | ¿La statusline corre en Desktop? | Cuando se instale (D11) | Cuota de Claude STALE en Desktop |

---

## 25. Fases de implementación y criterios de aceptación

Se construye con **Skill Creator**, en Claude Code CLI en la PC Windows (esta conversación no tiene shell local). Cada fase termina con tests en verde antes de pasar a la siguiente.

| Fase | Entregable | Criterio de aceptación |
|---|---|---|
| **F0** Base | `~/.claude/skills/orchestrator/` con `git init`, esqueleto, `config.defaults.json`, `~/.claude/orchestrator/` | La estructura de §12 existe. `node orch.mjs --help` funciona en Windows |
| **F1** Plataforma y procesos | `platform.mjs`, `proc.mjs` | Tests: resuelve los 4 ejecutables reales; spawn con `shell:false`; background + `status.json`; timeout que mata el árbol (con un proceso dummy) |
| **F2** `doctor` y `models` | `catalog.mjs` y los comandos | `doctor` reproduce los hallazgos de §3 y §5. `models refresh` genera `catalog.json` con el pool de §8 habilitado y el resto deshabilitado. Un modelo nuevo aparece con `new:true, enabled:false` |
| **F3** Cuotas | `quota/*` y `normalize` | Codex LIVE por app-server; Claude UNKNOWN (statusline no instalada); Devin por unofficial (o fallback a capas); agy UNKNOWN. Dashboard de §11.6. Tests de normalización, umbrales, reservas y ajuste por reset |
| **F4** Router | `router.mjs` + `route` | Tests con escenarios fijos: el ejemplo Devin 96/91% frente a Codex 95/28% elige Devin; un candidato malo con mucha cuota **no** gana; PROTECTED baja; UNKNOWN ≠ 100%; PLAN_CONTRADICTION no tiene fallback; FEATURE sin bootstrap elige Devin Sol Medium; con bootstrap alterna Sol y SWE-2 y excluye las corridas fallidas por causas externas. Salida en el formato de §9.4 |
| **F5** Adapters y run | `adapters/*`, `packet.mjs`, `classify.mjs`, `run`, `status`, `wait` | Smoke PONG en los 3 workers. Tarea "append OK + npm test" en un repo desechable con cada worker. Devin con `smart` → bloqueo simulado → allowlist específica o STOP. agy con modelo inválido → MODEL_UNAVAILABLE |
| **F6** Seguridad y validación | `safety.mjs`, `validate.mjs`, `preflight`, `postflight` | Tests: lock; snapshot sin tocar el working tree; detección de commit, borrado, cambio fuera de scope y comentario agregado; baseline frente a regresión |
| **F7** Skill | `SKILL.md` + `references/*` (con Skill Creator) | SKILL.md ≤250 líneas, `disable-model-invocation: true`, `argument-hint`. Las referencias se cargan según la necesidad |
| **F8** Historial y bootstrap | `history.mjs`, `bootstrap` | Se agrega sin datos sensibles; el router lo consulta; el bootstrap cuenta, alterna, calcula métricas y pide confirmación antes de reordenar |
| **F9** E2E | Repo desechable (RN/TS mínimo) | 5 escenarios: (1) SMALL_FIX → PASS; (2) contradicción forzada → STOP y Opus; (3) validación rota → repair → PASS; (4) cuota agotada simulada BEFORE_WORK → fallback; (5) DURING_WORK → continuation packet |
| **F10** Statusline | `statusline.mjs` + instrucciones | Preparado y probado con mock de stdin. **No se instala** (D11) |
| **F11** macOS | Inspección y ajustes | `doctor` en verde en la Mac y E2E del escenario 1 |

---

## 26. Fuera de alcance (v1)

- Paralelismo o varios workers a la vez (git worktrees). Si se propone, se investiga y se pregunta antes.
- Linux/CachyOS.
- Cambiar automáticamente de arquitecto si Claude está LOW.
- Usar automáticamente los reset credits de Codex.
- Instalar la statusline (hasta que Reed lo indique).
- ML o ponderaciones numéricas complejas en el router.
- Cualquier servicio, base de datos, daemon o Docker.

---

## 27. Fuentes

- Claude Code: [Skills](https://code.claude.com/docs/en/skills) · [Statusline](https://code.claude.com/docs/en/statusline) · [Desktop](https://code.claude.com/docs/en/desktop) · [Headless](https://code.claude.com/docs/en/headless)
- Devin: [CLI Commands](https://docs.devin.ai/cli/reference/commands) · [CLI Models](https://docs.devin.ai/cli/models) · [Quota](https://docs.devin.ai/desktop/accounts/quota) · [devin-cli-usage (terceros)](https://pypi.org/project/devin-cli-usage/)
- Codex: [Models](https://learn.chatgpt.com/docs/models) · [app-server README](https://forge.lthn.ai/core/core-agent-ide/src/commit/2e81f1900da465f1e65c3edfe212be715d707448/codex-rs/app-server) · [PR rateLimits/read](https://forge.lthn.ai/core/core-agent-ide/src/commit/32d50bda944661afcbe992f77d9fb0b2886130ca/codex-rs/app-server)
- Antigravity: [Headless](https://antigravity.google/docs/cli/headless) · [Model quotas](https://www.antigravity.google/docs/cli/commands/usage) · [Issue #76](https://github.com/google-antigravity/antigravity-cli/issues/76)
- SWE-2: [ecosistemastartup](https://ecosistemastartup.com/?p=106398) · [runtimewire](https://runtimewire.com/article/cognition-swe-2-coding-model-scott-wu) · [OrcaRouter](https://www.orcarouter.ai/blog/cognition-swe-2-release) · [BenchLM](https://benchlm.ai/models/swe-2)
- GPT-6.1 Sol / Luna: [ProPakistani](https://propakistani.pk/2026/09/30/gpt-6-1-sol-brings-astra-level-performance-at-5x-lower-cost/) · [Emergent](https://emergent.sh/learn/gpt-6-1-sol-benchmarks) · [Vellum](https://www.vellum.ai/md/blog/gpt-6-1-sol-benchmarks-explained) · [aicatchup](https://aicatchup.com/news/openai-gpt-6-sol-luna) · [tosea](https://tosea.ai/blog/gpt-6-sol-luna-complete-guide)
- Gemini 3.8 Flash: [DataCamp](https://www.datacamp.com/vi/blog/gemini-3-8-flash-cyber) · [BenchLM](https://benchlm.ai/models/gemini-3.8-flash)
- DeepSeek V4.1 Flash: [BenchLM](https://benchlm.ai/models/deepseek-v4-1-flash) · Kimi K2.7: [Kimi](https://www.kimi.com/resources/kimi-k2-7-code) · [Web Reactiva](https://www.webreactiva.com/blog/kimi-k2.7)
- Evidencia local: `C:\Users\<user>\orch-inspect\windows.json`, `windows-summary.md`, `windows-probe2.json`/`.md`, `windows-probe3.json`/`.md`, `raw\*.txt`
