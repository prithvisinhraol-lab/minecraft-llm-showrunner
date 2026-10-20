# Nether Crater Shrine Portal Base Design

## Goal

Build an original Nether portal base with the mood of a cursed domain shrine: monumental, sharp, dark, and ritualistic. The design should evoke the feeling of a blasted crater and shrine altar without copying a specific copyrighted structure.

## Site

Codex chooses a fresh dramatic location away from the busy combat area. The build should sit in a crater-like depression or a flat area that can be reshaped into one, with a clear teleport/access point for the player.

## Visual Design

- Central oversized Nether portal framed in crying obsidian, obsidian, polished blackstone, and gilded blackstone.
- A circular blasted crater floor using blackstone, basalt, deepslate, magma blocks, soul soil, nether wart blocks, and cracked/decorative variants.
- Shrine-like stepped altar around the portal, with a front stair approach and a ritual platform.
- Dark purple lighting system using amethyst clusters, purple stained glass, end rods hidden behind tinted/purple glass, candles, and crying obsidian.
- Spiked shrine ribs and ruined pillars around the ring, using blackstone walls, basalt, chains, iron bars, and pointed silhouettes.
- Crimson accents and soul fire details for contrast, kept secondary so the dominant read is black and purple.

## Functional Requirements

- The Nether portal must be lit and usable.
- The structure must have an obvious entrance path and safe standing areas.
- The shrine should be visible from a distance, especially at night.
- The build should be saved after construction.

## Build Method

Use live server console commands in bounded batches. Use fill/setblock/summon commands and keep each edit under Minecraft command block limits. Force-load the target chunks while building if needed, then remove force-loads and save the world.

## Verification

- Confirm commands succeed in the server log.
- Confirm the portal frame is complete and lit.
- Teleport the player to a viewing/entrance position when done.
- Run `save-all` and confirm the server reports the save.
