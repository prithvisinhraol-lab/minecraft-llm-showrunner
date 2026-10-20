# Domain Rupture Crater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the neat shrine crater at `900 86 -360` into a fully covered, jagged cursed impact crater.

**Architecture:** Execute bounded Minecraft server-console commands against the running local Java server. Force-load the shrine area, add irregular full-wall skins and ledges, scatter rubble and scars, add cursed lighting pockets, verify the portal, teleport the player to the entrance, release force-loads, and save.

**Tech Stack:** Minecraft Java 1.21.4 server console commands, vanilla blocks, local server stdin.

## Global Constraints

- Preserve entrance/view coordinates at `900 84 -392`.
- Preserve portal center at `900 82 -360` and verify it is still `nether_portal`.
- Keep the shrine playable and visible at night.
- Save the world after the roughening pass.

---

### Task 1: Load And Protect Shrine

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: running server console
- Produces: loaded work area with protected portal

- [ ] **Step 1: Force-load work area**

Run:

```mcfunction
forceload add 872 -392 928 -332
say Roughening the shrine crater into a cursed rupture.
```

Expected: server reports shrine chunks force-loaded.

- [ ] **Step 2: Preserve the portal core**

Run:

```mcfunction
fill 895 81 -360 905 81 -360 obsidian
fill 895 82 -360 895 91 -360 obsidian
fill 905 82 -360 905 91 -360 obsidian
fill 895 92 -360 905 92 -360 obsidian
fill 896 82 -360 904 91 -360 nether_portal[axis=x]
```

Expected: portal survives the roughening pass.

### Task 2: Fully Cover And Break The Walls

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: loaded shrine area
- Produces: all four crater walls covered with irregular layers

- [ ] **Step 1: Skin the outer walls with dark layers**

Run:

```mcfunction
fill 874 79 -386 926 88 -386 deepslate_tiles
fill 874 79 -334 926 88 -334 polished_blackstone_bricks
fill 874 79 -386 874 88 -334 cracked_deepslate_bricks
fill 926 79 -386 926 88 -334 blackstone
fill 877 80 -383 923 87 -383 cracked_deepslate_tiles
fill 877 80 -337 923 87 -337 blackstone
fill 877 80 -383 877 87 -337 polished_blackstone_bricks
fill 923 80 -383 923 87 -337 deepslate_bricks
```

Expected: the visible crater perimeter is fully materialized.

- [ ] **Step 2: Add uneven ledges and collapsed shelves**

Run:

```mcfunction
fill 879 86 -382 895 86 -379 blackstone
fill 902 84 -382 919 84 -380 basalt
fill 881 82 -381 888 82 -378 soul_soil
fill 911 87 -381 922 87 -379 polished_blackstone
fill 880 85 -341 897 85 -338 cracked_deepslate_bricks
fill 903 83 -342 918 83 -338 blackstone
fill 882 81 -343 889 81 -339 soul_soil
fill 912 87 -343 922 87 -339 basalt
fill 878 86 -376 881 86 -361 polished_blackstone
fill 878 83 -356 881 83 -342 cracked_deepslate_tiles
fill 919 85 -378 922 85 -363 blackstone
fill 919 82 -358 922 82 -344 soul_soil
```

Expected: wall surfaces have protrusions and uneven shelf heights.

- [ ] **Step 3: Cut irregular bite marks into the rim**

Run:

```mcfunction
fill 886 87 -386 892 90 -386 air
fill 909 88 -386 916 91 -386 air
fill 878 86 -374 878 90 -368 air
fill 878 85 -352 878 88 -346 air
fill 922 87 -377 922 91 -371 air
fill 922 84 -355 922 88 -349 air
fill 889 87 -334 896 90 -334 air
fill 905 86 -334 913 89 -334 air
```

Expected: the crater outline becomes ragged instead of rectangular.

### Task 3: Add Cursed Scars, Rubble, And Wall Details

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: broken wall geometry
- Produces: detailed cursed crater with glow pockets, rubble, chains, and bones

- [ ] **Step 1: Add purple wounds and magma cracks**

Run:

```mcfunction
setblock 885 84 -383 crying_obsidian
setblock 897 86 -383 purple_stained_glass
setblock 913 83 -383 magma_block
setblock 919 86 -383 crying_obsidian
setblock 881 84 -337 magma_block
setblock 895 86 -337 crying_obsidian
setblock 906 83 -337 purple_stained_glass
setblock 920 85 -337 magma_block
setblock 877 84 -371 crying_obsidian
setblock 877 86 -357 purple_stained_glass
setblock 923 83 -374 magma_block
setblock 923 86 -351 crying_obsidian
```

Expected: all walls get non-uniform cursed scars.

- [ ] **Step 2: Add vertical basalt teeth and blackstone spikes**

Run:

```mcfunction
fill 884 84 -382 884 93 -382 basalt
fill 899 82 -382 899 90 -382 polished_basalt
fill 917 85 -382 917 96 -382 basalt
fill 887 83 -338 887 91 -338 polished_basalt
fill 904 85 -338 904 95 -338 basalt
fill 919 82 -338 919 89 -338 polished_basalt
fill 878 84 -366 878 94 -366 basalt
fill 922 83 -354 922 92 -354 basalt
setblock 884 94 -382 blackstone_wall
setblock 917 97 -382 blackstone_wall
setblock 904 96 -338 blackstone_wall
setblock 878 95 -366 blackstone_wall
```

Expected: wall silhouettes gain height and jaggedness.

- [ ] **Step 3: Add embedded bone ribs and hanging chains**

Run:

```mcfunction
fill 890 86 -383 890 94 -383 bone_block
fill 908 84 -383 908 92 -383 bone_block
fill 893 85 -337 893 93 -337 bone_block
fill 911 86 -337 911 96 -337 bone_block
fill 877 85 -365 877 93 -365 bone_block
fill 923 84 -356 923 92 -356 bone_block
setblock 890 95 -383 calcite
setblock 911 97 -337 calcite
setblock 877 94 -365 calcite
setblock 923 93 -356 calcite
setblock 896 88 -383 chain[axis=y]
setblock 915 89 -383 chain[axis=y]
setblock 884 88 -337 chain[axis=y]
setblock 918 88 -337 chain[axis=y]
```

Expected: the walls tie visually into the skeletal shrine.

- [ ] **Step 4: Scatter rubble piles across floor and ledges**

Run:

```mcfunction
setblock 887 84 -371 cobbled_deepslate
setblock 888 85 -371 blackstone_wall
setblock 894 82 -376 basalt
setblock 907 83 -374 cobbled_deepslate
setblock 914 84 -368 blackstone
setblock 918 83 -356 basalt
setblock 910 81 -346 cobbled_deepslate
setblock 897 80 -349 blackstone_wall
setblock 883 82 -352 basalt
setblock 891 83 -344 cracked_deepslate_bricks
setblock 906 80 -365 magma_block
setblock 912 82 -352 soul_soil
```

Expected: crater floor feels collapsed and rough.

### Task 4: Final Atmosphere And Save

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: detailed crater
- Produces: saved, verified, player-visible final build

- [ ] **Step 1: Add fire and purple lighting to rough walls**

Run:

```mcfunction
setblock 881 83 -381 soul_fire
setblock 882 82 -340 soul_fire
setblock 920 83 -358 soul_fire
setblock 913 84 -383 soul_fire
setblock 895 87 -383 end_rod
setblock 895 88 -383 purple_stained_glass
setblock 906 87 -337 end_rod
setblock 906 88 -337 purple_stained_glass
setblock 877 87 -357 end_rod
setblock 878 87 -357 purple_stained_glass
setblock 923 87 -351 end_rod
setblock 922 87 -351 purple_stained_glass
```

Expected: rough wall details remain visible at night.

- [ ] **Step 2: Verify and save**

Run:

```mcfunction
time set midnight
tp VPNAJ 900 84 -392 0 15
execute if block 900 82 -360 nether_portal run say Verified rupture crater portal.
say Domain rupture crater complete. Entrance: 900 84 -392. Portal: 900 82 -360.
forceload remove 872 -392 928 -332
save-all
```

Expected: player lands at the entrance, portal verification prints, chunks release, and server reports `Saved the game`.
