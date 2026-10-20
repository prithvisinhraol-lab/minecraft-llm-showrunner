# Nether Hub Litematic Paste Design

## Goal

Paste `/Users/jayraol/Downloads/Nether Hub.litematic` into the Nether at a location chosen by Codex, with a natural support/foundation so it does not look like it is floating.

## Placement

- Dimension: `minecraft:the_nether`
- Safe arrival point: `300.5 80 300.5`
- Paste minimum corner: `255 78 256`
- Schematic size: `90 x 56 x 89`

This centers the litematic around the existing safe pad near `300 80 300`.

## Build Method

- Generate a datapack function from the `.litematic` block palette and packed block states.
- Map outdated `minecraft:iron_chain` blocks to `minecraft:chain`.
- Paste non-air blocks in scheduled batches to avoid freezing the server.
- Add natural Nether supports before/after the paste using blackstone, basalt, netherrack, soul soil, magma, and lava accents.
- Preserve a safe clear landing area at `300.5 80 300.5`.

## Verification

- Confirm the paste functions run.
- Confirm representative blocks exist at the paste area.
- Teleport the player to the safe arrival point.
- Save the world after construction.
