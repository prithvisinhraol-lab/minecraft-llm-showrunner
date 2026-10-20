# AI Minecraft Server

The experimental LLM runtime now includes a generated-goal pipeline: a slower LLM prepares bounded goal contracts while a faster LLM controls one Mineflayer character inside the active contract. Deterministic code validates every contract, action result, promotion, and success claim. Use `pipeline start` in Minecraft chat without a slash. See `docs/llm-agent-operations.md` for exact commands, limits, recovery, and the live evidence gate. The earlier catalog-based director remains available as a smaller proven baseline.

## Mission

This project explores how an AI can interact directly with a persistent Minecraft server so a person can play alongside, collaborate with, and challenge the AI inside the game.

The server is more than a static world or chatbot demo. It is a live environment where the AI can observe game state, move through the world, communicate, fight, build, operate server tools, and help create shared experiences. The current system is an experimental first version; part of the project is determining the best architecture for deeper, safer, and more natural AI interaction.

## How AI Interacts Today

The current system has three complementary interaction paths:

- **Mineflayer bot:** gives the AI an embodied Minecraft player that can perceive nearby blocks and entities, navigate, chat, manage equipment, and perform combat actions.
- **Server console:** lets the AI inspect and administer the local server, teleport players, issue world commands, monitor logs, and save the world.
- **Generated datapacks:** let the AI perform large, deterministic builds in staged batches when ordinary block-by-block bot construction would be too slow or unreliable.

These paths work, but they are fragmented. Mineflayer provides embodiment while console commands and datapacks provide broader world control.

## Current Capabilities

- Start, monitor, diagnose, and save the local server.
- Join through a Mineflayer-controlled bot.
- Follow players, look at them, chat, and report position.
- Navigate using pathfinding.
- Equip and operate shields.
- Run rod, mace, TNT-minecart, and scripted combat experiments.
- Build and import large structures with generated datapacks.
- Inspect locations and teleport players to verified safe positions.
- Run cinematic battle experiments through the movie-war scripts.

## World Projects

Known completed or actively maintained locations include:

- **City/district:** Overworld arrival at `532 92 44`.
- **Compact FlameFrags-inspired base:** Overworld center near `5044 65 2348`; safe entrance at `5044.5 66 2323.5`.
- **Nether hub:** Nether arrival near `300.5 80 300.5`.
- **Cursed crater shrine:** Overworld structure centered near `900 86 -360`; documented entrance at `900 84 -392`.

Design specifications and implementation plans for major builds are stored under `docs/superpowers/`.

## Future Direction

The next architectural question is whether to replace the separate bot, console, and datapack control paths with a unified, safety-controlled AI bridge.

That bridge could expose a consistent set of tools for:

- Perception and world queries.
- Navigation and embodied actions.
- Inventory and crafting.
- Combat and cooperation.
- Block placement and construction.
- Approved server administration.
- Persistent goals, memories, and world events.

This unified bridge is a direction to evaluate, not an implemented feature. Different approaches—including a richer Mineflayer service, a server plugin or mod, and a hybrid control API—should be compared before choosing the long-term architecture.

## Quick Start

The project currently targets Minecraft Java Edition `1.21.4`, a stable version supported by the installed Mineflayer setup. Use a matching `1.21.4` Minecraft Launcher profile.

Requirements:

- Minecraft Java Edition.
- A command-line Java runtime, such as Temurin or OpenJDK 21.
- Node.js and npm.

Install Node dependencies:

```sh
npm install
```

Optionally create a local bot configuration:

```sh
cp .env.example .env
```

Download the vanilla server jar when it is not already present:

```sh
npm run download-server
```

After reading the Minecraft EULA, accept it in `server/eula.txt`, then start the server:

```sh
npm run server
```

In Minecraft Java Edition:

1. Open Multiplayer.
2. Add or directly connect to `127.0.0.1:25565`.
3. Join the world using Minecraft Java `1.21.4`.

Start the AI-controlled bot in another terminal:

```sh
npm run bot
```

Run the automated tests with:

```sh
npm test
```

## Bounded survival demo

The older single-actor survival demonstration remains separate from the generated-goal pipeline. It waits without connecting `LlmAgent` until the authorized player sends the exact start mark. It then gathers wood, makes and places a crafting table, makes and equips a wooden pickaxe, mines eight cobblestone, crafts a furnace, verifies a real village, and says `This is gonna be great!!!` only after every proof gate passes.

Start these in separate Terminal windows:

```sh
npm run server
SURVIVAL_DEMO_LOG_PATH=/absolute/path/to/server/logs/latest.log npm run survival-demo
```

Then use Minecraft chat as `VPNAJ`:

```text
start
```

Emergency stop, also in Minecraft chat with no slash:

```text
stop
```

`start` and `stop` are lowercase, exact, and have no leading `/`. The demo is one-shot and preserves its state; remove or archive `runtime/survival-demo-state` deliberately before a new rehearsal. Unit tests do not prove the clearing resources or a village are reachable in the live world.

## In-Game Bot Commands

Type these commands in Minecraft chat:

- `bot come` makes the bot pathfind near you.
- `bot stop` stops the bot.
- `bot say <message>` makes the bot chat.
- `bot pos` prints the bot position.
- `bot look` makes the bot look at you.
- `bot shield up` equips and raises the bot's shield.
- `bot shield down` lowers the shield.
- `bot practice` stops the bot, faces you, and raises its shield.

Additional combat and cinematic experiments are available through the npm scripts in `package.json`.

## Security Notes

The default server is intended for local experimentation. It binds to the local machine and uses `online-mode=false`, allowing the Mineflayer bot to connect with an offline username instead of requiring a second paid Microsoft account.

Do not expose this configuration directly to the internet. Before allowing LAN or internet connections, review authentication, whitelist, permissions, command access, firewall rules, and the risks of offline mode.

## Showrunner production safety

The two-actor showrunner is a separate, safety-controlled production path. Its
approved design is the [Showrunner MVP specification](docs/superpowers/specs/2026-08-05-llm-video-showrunner-design.md), and its implementation scope is recorded in the [implementation plan](docs/superpowers/plans/2026-08-05-two-actor-showrunner-mvp.md). Operators must follow the [showrunner operations runbook](docs/showrunner-operations.md) before attempting a take.

The legacy `bot ...` chat commands and the combat/cinematic scripts are
experimental tools. They must **not** be used as the control path for an
LLM-directed production take. In particular, Minecraft player chat is not a
director-control channel, production actors must be non-operators, and only a
creator-approved dialogue bank may supply dialogue for a take.

The repository currently provides the tested showrunner core and CLI contract,
but it does not include the native production-host adapters required to operate
the live workflow. The CLI therefore fails closed for live commands until an
authorized host composes the actor, controller, rooted-artifact, and
rooted-recording capabilities described in the runbook. Do not call an MVP
take accepted until the required live evidence exists.
