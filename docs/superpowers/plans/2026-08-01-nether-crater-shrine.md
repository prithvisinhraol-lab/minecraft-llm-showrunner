# Nether Crater Shrine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dramatic blasted-crater Nether portal shrine with dark purple lighting and safe player access.

**Architecture:** Execute bounded Minecraft server-console commands against the already-running local Java server. Use a chosen remote overworld site, force-load the chunks, sculpt the terrain, place the shrine and portal, decorate with lighting and particles-friendly blocks, then save the world.

**Tech Stack:** Minecraft Java 1.21.4 server console commands, vanilla blocks, local server stdin.

## Global Constraints

- Build an original cursed shrine mood without copying a specific copyrighted structure.
- The Nether portal must be lit and usable.
- The structure must have an obvious entrance path and safe standing areas.
- The shrine should be visible from a distance, especially at night.
- Run `save-all` and confirm the server reports the save.

---

### Task 1: Site Preparation

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: running server console session
- Produces: force-loaded, cleared build site centered at `900 86 -360`

- [ ] **Step 1: Force-load build chunks**

Run:

```mcfunction
forceload add 880 -380 920 -340
```

Expected: server reports force-loaded chunks.

- [ ] **Step 2: Announce build location**

Run:

```mcfunction
say Building the Nether Crater Shrine at 900 86 -360.
```

Expected: player sees the build location.

- [ ] **Step 3: Clear and stabilize the site**

Run these commands:

```mcfunction
fill 870 86 -390 900 122 -360 air
fill 901 86 -390 930 122 -360 air
fill 870 86 -359 900 122 -330 air
fill 901 86 -359 930 122 -330 air
fill 872 75 -388 900 85 -360 deepslate
fill 901 75 -388 928 85 -360 deepslate
fill 872 75 -359 900 85 -332 deepslate
fill 901 75 -359 928 85 -332 deepslate
fill 880 86 -380 920 86 -340 polished_blackstone
```

Expected: open air above the site, solid base below, dark surface floor.

### Task 2: Crater Shape

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: prepared site from Task 1
- Produces: blasted circular crater with safe central platform

- [ ] **Step 1: Cut stepped crater depression**

Run:

```mcfunction
fill 876 86 -384 924 88 -336 air
fill 882 84 -378 918 86 -342 air
fill 888 82 -372 912 84 -348 air
fill 893 80 -367 907 82 -353 air
```

Expected: stepped depression centered on the portal area.

- [ ] **Step 2: Add broken volcanic floor colors**

Run:

```mcfunction
fill 878 83 -382 922 83 -338 blackstone
fill 884 81 -376 916 81 -344 basalt
fill 890 79 -370 910 79 -350 polished_blackstone
fill 895 80 -365 905 80 -355 crying_obsidian
```

Expected: crater reads black, basaltic, and purple-lit at center.

- [ ] **Step 3: Add magma fissures**

Run:

```mcfunction
fill 880 84 -360 892 84 -358 magma_block
fill 908 84 -362 920 84 -360 magma_block
fill 898 82 -378 900 82 -366 magma_block
fill 900 82 -354 902 82 -342 magma_block
```

Expected: warm cracks break up the purple-black palette.

### Task 3: Portal Shrine Core

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: crater floor from Task 2
- Produces: lit Nether portal inside a shrine altar

- [ ] **Step 1: Build oversized portal frame**

Run:

```mcfunction
fill 895 81 -360 905 81 -360 obsidian
fill 895 82 -360 895 91 -360 obsidian
fill 905 82 -360 905 91 -360 obsidian
fill 895 92 -360 905 92 -360 obsidian
fill 896 82 -360 904 91 -360 air
setblock 900 82 -360 fire
```

Expected: portal lights in the center of the shrine.

- [ ] **Step 2: Wrap the portal in crying obsidian and blackstone**

Run:

```mcfunction
fill 893 80 -361 907 80 -361 polished_blackstone_bricks
fill 893 93 -361 907 93 -361 polished_blackstone_bricks
fill 893 81 -361 893 92 -361 crying_obsidian
fill 907 81 -361 907 92 -361 crying_obsidian
setblock 900 94 -361 gilded_blackstone
```

Expected: portal becomes a shrine gate, not a plain rectangle.

- [ ] **Step 3: Create altar stairs and platform**

Run:

```mcfunction
fill 892 80 -365 908 80 -357 polished_blackstone
fill 894 81 -364 906 81 -358 polished_blackstone_bricks
fill 896 82 -363 904 82 -359 chiseled_polished_blackstone
fill 898 83 -362 902 83 -360 gilded_blackstone
fill 896 80 -372 904 80 -366 polished_blackstone
fill 897 81 -369 903 81 -366 polished_blackstone_stairs[facing=south]
```

Expected: safe ceremonial approach from the south side.

### Task 4: Shrine Ribs And Ruins

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: portal core from Task 3
- Produces: spiked circular shrine silhouette

- [ ] **Step 1: Add four main shrine pillars**

Run:

```mcfunction
fill 884 81 -376 884 93 -376 polished_basalt
fill 916 81 -376 916 93 -376 polished_basalt
fill 884 81 -344 884 93 -344 polished_basalt
fill 916 81 -344 916 93 -344 polished_basalt
```

Expected: visible boundary posts around the crater.

- [ ] **Step 2: Add blackstone spikes**

Run:

```mcfunction
fill 884 94 -376 884 98 -376 blackstone_wall
fill 916 94 -376 916 98 -376 blackstone_wall
fill 884 94 -344 884 98 -344 blackstone_wall
fill 916 94 -344 916 98 -344 blackstone_wall
setblock 884 99 -376 pointed_dripstone[vertical_direction=up]
setblock 916 99 -376 pointed_dripstone[vertical_direction=up]
setblock 884 99 -344 pointed_dripstone[vertical_direction=up]
setblock 916 99 -344 pointed_dripstone[vertical_direction=up]
```

Expected: jagged shrine corners frame the portal.

- [ ] **Step 3: Add rib-like ruined arcs**

Run:

```mcfunction
fill 889 86 -376 889 91 -376 blackstone_wall
fill 893 86 -378 893 92 -378 blackstone_wall
fill 907 86 -378 907 92 -378 blackstone_wall
fill 911 86 -376 911 91 -376 blackstone_wall
fill 889 86 -344 889 91 -344 blackstone_wall
fill 893 86 -342 893 92 -342 blackstone_wall
fill 907 86 -342 907 92 -342 blackstone_wall
fill 911 86 -344 911 91 -344 blackstone_wall
```

Expected: dark ribs imply a cursed shrine around the crater.

### Task 5: Purple Lighting And Details

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: shrine silhouette from Task 4
- Produces: dark purple lighting system and finished atmosphere

- [ ] **Step 1: Add hidden purple-lit glass wells**

Run:

```mcfunction
setblock 890 84 -370 end_rod
setblock 910 84 -370 end_rod
setblock 890 84 -350 end_rod
setblock 910 84 -350 end_rod
setblock 890 85 -370 purple_stained_glass
setblock 910 85 -370 purple_stained_glass
setblock 890 85 -350 purple_stained_glass
setblock 910 85 -350 purple_stained_glass
```

Expected: purple glow points mark the crater edges.

- [ ] **Step 2: Add amethyst and candles around the portal**

Run:

```mcfunction
setblock 894 84 -362 amethyst_cluster
setblock 906 84 -362 amethyst_cluster
setblock 894 84 -358 amethyst_cluster
setblock 906 84 -358 amethyst_cluster
setblock 897 84 -364 purple_candle[candles=4,lit=true]
setblock 903 84 -364 purple_candle[candles=4,lit=true]
setblock 897 84 -356 purple_candle[candles=4,lit=true]
setblock 903 84 -356 purple_candle[candles=4,lit=true]
```

Expected: close-up detail sells the purple shrine lighting.

- [ ] **Step 3: Add chains, soul fire, and crimson accents**

Run:

```mcfunction
setblock 892 91 -361 chain[axis=y]
setblock 908 91 -361 chain[axis=y]
setblock 900 95 -361 chain[axis=y]
setblock 886 82 -370 soul_fire
setblock 914 82 -370 soul_fire
setblock 886 82 -350 soul_fire
setblock 914 82 -350 soul_fire
fill 888 84 -360 890 84 -360 nether_wart_block
fill 910 84 -360 912 84 -360 nether_wart_block
```

Expected: the shrine has ritual detail without losing the purple-black read.

### Task 6: Access, Player Placement, And Save

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: completed shrine from Task 5
- Produces: accessible saved build

- [ ] **Step 1: Add path and arrival point**

Run:

```mcfunction
fill 896 80 -390 904 80 -373 polished_blackstone
fill 899 81 -389 901 81 -373 polished_blackstone_slab[type=bottom]
setblock 900 81 -391 lodestone
time set midnight
```

Expected: the front approach is obvious and safe.

- [ ] **Step 2: Teleport nearby players to the viewing entrance**

Run:

```mcfunction
tp @a 900 84 -392 0 15
say Nether Crater Shrine complete. Walk north into the crater.
```

Expected: players land at the entrance, looking toward the portal.

- [ ] **Step 3: Clean up and save**

Run:

```mcfunction
forceload remove 880 -380 920 -340
save-all
```

Expected: server reports chunks saved and world saved.
