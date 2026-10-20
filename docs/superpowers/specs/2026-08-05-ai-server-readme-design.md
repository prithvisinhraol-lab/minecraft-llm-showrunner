# AI Minecraft Server README Design

## Goal

Update the project README so its primary mission is clear: create a way for AI to interact directly with a persistent Minecraft server so the player can play alongside and collaborate with the AI.

## Structure

The README will present information in this order:

1. Project mission and experimental status.
2. Current architecture and interaction paths.
3. Current AI capabilities.
4. Completed world projects and useful coordinates.
5. Setup and in-game commands.
6. Known limitations and future architectural direction.

## Current Architecture

Document the three existing interaction paths:

- Mineflayer provides an embodied bot that can perceive nearby entities and blocks, move, chat, use equipment, and fight.
- Direct server-console control provides administration, teleportation, inspection, and immediate world commands.
- Generated datapacks provide deterministic, staged construction for builds too large or precise for ordinary bot placement.

These paths are useful but fragmented and should be described as the current experimental implementation rather than the final design.

## Future Direction

State that the likely next architectural step is a unified, safety-controlled AI bridge. It should eventually expose perception, navigation, inventory, combat, building, world queries, and approved server administration through one consistent interface.

The README will not select or promise a specific bridge technology yet. Architecture alternatives should be evaluated separately before implementation.

## Completed World Work

Record the currently known locations:

- City/district arrival: `532 92 44` in the Overworld.
- Compact FlameFrags-inspired base: `5044 65 2348` in the Overworld, with a safe entrance at `5044.5 66 2323.5`.
- Nether hub: approximately `300 80 300` in the Nether.
- Cursed crater shrine: approximately `900 86 -360` in the Overworld, with its documented entrance at `900 84 -392`.

## Accuracy and Safety

- Keep Java version `1.21.4` and local address `127.0.0.1:25565` explicit.
- Explain that `online-mode=false` is suitable only for the local setup and must be reviewed before network exposure.
- Do not present future capabilities as already implemented.
