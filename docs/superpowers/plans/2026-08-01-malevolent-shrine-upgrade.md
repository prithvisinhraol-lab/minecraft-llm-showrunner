# Malevolent Shrine Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Nether Crater Shrine at `900 86 -360` into a stronger cursed temple-and-bone shrine with fully treated crater walls.

**Architecture:** Execute bounded Minecraft server-console commands against the running local Java server. Force-load the shrine chunks, preserve the existing portal and entrance, skin the crater walls, add a blackstone roof/crown, add bone/calcite rib silhouettes and dripstone portal teeth, then verify and save.

**Tech Stack:** Minecraft Java 1.21.4 server console commands, vanilla blocks, local server stdin.

## Global Constraints

- Keep the build original and inspired by the mood, not a direct replica.
- Preserve the existing usable Nether portal at the shrine core.
- Preserve the safe entrance and viewing path at `900 84 -392`.
- Keep edits bounded around the existing shrine so nearby builds are not affected.
- Save the world after construction and verify the portal still exists.

---

### Task 1: Force-Load And Protect Core

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: running server console session
- Produces: force-loaded shrine area and protected portal core

- [ ] **Step 1: Force-load shrine chunks**

Run:

```mcfunction
forceload add 880 -392 920 -332
say Upgrading the crater shrine into a darker cursed shrine domain.
```

Expected: server reports 12 shrine chunks force-loaded and chat announces the upgrade.

- [ ] **Step 2: Reassert the portal core before upgrades**

Run:

```mcfunction
fill 895 81 -360 905 81 -360 obsidian
fill 895 82 -360 895 91 -360 obsidian
fill 905 82 -360 905 91 -360 obsidian
fill 895 92 -360 905 92 -360 obsidian
fill 896 82 -360 904 91 -360 nether_portal[axis=x]
```

Expected: existing portal frame remains usable before new detailing.

### Task 2: Cursed Crater Wall Covering

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: force-loaded shrine area
- Produces: layered wall panels, cursed veins, and purple glow pockets around crater perimeter

- [ ] **Step 1: Add dark retaining walls around the crater**

Run:

```mcfunction
fill 876 81 -384 924 86 -384 polished_blackstone_bricks
fill 876 81 -336 924 86 -336 polished_blackstone_bricks
fill 876 81 -384 876 86 -336 polished_blackstone_bricks
fill 924 81 -384 924 86 -336 polished_blackstone_bricks
```

Expected: the crater perimeter reads as deliberate shrine walling.

- [ ] **Step 2: Add inner broken wall layers**

Run:

```mcfunction
fill 880 82 -380 920 85 -380 cracked_deepslate_bricks
fill 880 82 -340 920 85 -340 cracked_deepslate_bricks
fill 880 82 -380 880 85 -340 cracked_deepslate_bricks
fill 920 82 -380 920 85 -340 cracked_deepslate_bricks
fill 886 83 -374 914 86 -374 basalt
fill 886 83 -346 914 86 -346 basalt
fill 886 83 -374 886 86 -346 basalt
fill 914 83 -374 914 86 -346 basalt
```

Expected: walls have depth and ribbed basalt bands instead of flat surfaces.

- [ ] **Step 3: Add cursed purple glow pockets and crimson veins**

Run:

```mcfunction
setblock 900 84 -384 crying_obsidian
setblock 900 84 -336 crying_obsidian
setblock 876 84 -360 crying_obsidian
setblock 924 84 -360 crying_obsidian
setblock 900 85 -383 purple_stained_glass
setblock 900 85 -337 purple_stained_glass
setblock 877 85 -360 purple_stained_glass
setblock 923 85 -360 purple_stained_glass
fill 888 86 -384 892 86 -384 crimson_nylium
fill 908 86 -336 912 86 -336 crimson_nylium
fill 876 86 -372 876 86 -368 nether_wart_block
fill 924 86 -352 924 86 -348 nether_wart_block
```

Expected: wall covering gains purple-lit cursed focal points and red organic accents.

### Task 3: Black Shrine Crown

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: protected portal core and wall covering
- Produces: dark temple-gate silhouette behind the portal

- [ ] **Step 1: Add rear shrine body behind portal**

Run:

```mcfunction
fill 892 81 -366 908 86 -366 polished_blackstone_bricks
fill 893 87 -367 907 89 -367 deepslate_tiles
fill 894 90 -368 906 91 -368 polished_blackstone
fill 896 92 -369 904 93 -369 gilded_blackstone
```

Expected: portal has a dark shrine mass behind it.

- [ ] **Step 2: Add layered roof/crown**

Run:

```mcfunction
fill 890 94 -370 910 94 -366 polished_blackstone_stairs[facing=south]
fill 892 95 -369 908 95 -365 deepslate_tile_stairs[facing=south]
fill 894 96 -368 906 96 -364 polished_blackstone_stairs[facing=south]
fill 897 97 -367 903 97 -363 blackstone
setblock 900 98 -363 gilded_blackstone
```

Expected: shrine gains a tiered roof silhouette visible from the entrance.

- [ ] **Step 3: Add crimson trim**

Run:

```mcfunction
fill 891 93 -365 909 93 -365 crimson_stem[axis=x]
fill 893 91 -364 907 91 -364 stripped_crimson_stem[axis=x]
setblock 892 90 -365 crimson_wall_sign[facing=south]
setblock 908 90 -365 crimson_wall_sign[facing=south]
```

Expected: subtle red trim makes the shrine feel ceremonial and dangerous.

### Task 4: Bone Ribs And Portal Maw

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: black shrine crown
- Produces: skeletal shrine silhouette and maw-like portal frame

- [ ] **Step 1: Add tall bone ribs behind the crown**

Run:

```mcfunction
fill 887 86 -368 887 98 -368 bone_block
fill 891 88 -370 891 101 -370 bone_block
fill 895 90 -372 895 103 -372 bone_block
fill 905 90 -372 905 103 -372 bone_block
fill 909 88 -370 909 101 -370 bone_block
fill 913 86 -368 913 98 -368 bone_block
```

Expected: pale vertical ribs rise behind the black shrine.

- [ ] **Step 2: Bend ribs inward with calcite tips**

Run:

```mcfunction
fill 891 101 -370 895 101 -370 calcite
fill 895 103 -372 899 103 -372 calcite
fill 901 103 -372 905 103 -372 calcite
fill 905 101 -370 909 101 -370 calcite
setblock 899 104 -372 pointed_dripstone[vertical_direction=up]
setblock 901 104 -372 pointed_dripstone[vertical_direction=up]
```

Expected: ribs feel clawed and shrine-like instead of simple posts.

- [ ] **Step 3: Add portal teeth and lower maw**

Run:

```mcfunction
setblock 897 92 -359 pointed_dripstone[vertical_direction=down]
setblock 899 92 -359 pointed_dripstone[vertical_direction=down]
setblock 901 92 -359 pointed_dripstone[vertical_direction=down]
setblock 903 92 -359 pointed_dripstone[vertical_direction=down]
setblock 897 81 -359 pointed_dripstone[vertical_direction=up]
setblock 899 81 -359 pointed_dripstone[vertical_direction=up]
setblock 901 81 -359 pointed_dripstone[vertical_direction=up]
setblock 903 81 -359 pointed_dripstone[vertical_direction=up]
fill 894 82 -358 906 82 -358 nether_wart_block
fill 896 83 -358 904 83 -358 crimson_roots
```

Expected: the portal reads like a cursed mouth at the center of the shrine.

### Task 5: Final Lighting, Access, And Save

**Files:**
- Modify: live server world only

**Interfaces:**
- Consumes: completed shrine upgrade
- Produces: verified, saved, player-accessible build

- [ ] **Step 1: Increase purple lighting density**

Run:

```mcfunction
setblock 892 88 -362 purple_candle[candles=4,lit=true]
setblock 908 88 -362 purple_candle[candles=4,lit=true]
setblock 892 87 -358 amethyst_cluster
setblock 908 87 -358 amethyst_cluster
setblock 900 99 -364 end_rod
setblock 900 100 -364 purple_stained_glass
setblock 900 84 -372 soul_lantern
setblock 900 84 -348 soul_lantern
```

Expected: the crown and crater center are visibly purple/cold-lit at night.

- [ ] **Step 2: Return player to safe viewing point**

Run:

```mcfunction
time set midnight
tp VPNAJ 900 84 -392 0 15
say Shrine upgrade complete. Coordinates: 900 84 -392. Center: 900 82 -360.
```

Expected: player sees the finished build from the entrance.

- [ ] **Step 3: Verify portal, release chunks, and save**

Run:

```mcfunction
execute if block 900 82 -360 nether_portal run say Verified upgraded shrine portal.
forceload remove 880 -392 920 -332
save-all
```

Expected: server reports the portal verification message, force-load removal, and `Saved the game`.
