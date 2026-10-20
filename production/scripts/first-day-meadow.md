# First Day in the Meadow

## Cast

- **Practical — Hero:** dry, observant, and focused on the next useful task.
- **Energetic — Rival:** confident, curious, and quick to revise a harmless bad guess.

## Set

A bright overworld meadow with flowers, passive animals, open sight lines, two
approved oak regions, a flat crafting mark, and a shallow two-wide mine entrance.
The camera is operated separately and never becomes an actor command.

## Current runtime boundary

Camera notes and actor blocking are filmable now. The bounded Survival runtime can
execute the named movement, gathering, crafting, placement, and excavation cues in
an automated fake-host take. A live take still requires the future authenticated
production-host adapters; neither actor receives operator or arbitrary-command access.

## Cue legend

Every action follows `prepare -> execute -> observe -> confirm`. Targets are selected
from approved regions, completion comes from authoritative observation, and each
beat's fixed dialogue completes before its Survival goals begin. Fixed lines advance
the story; optional improvisation may add a reaction but cannot complete a cue.

## Beat 1 — Arrival

**Cue ID**: `arrival`

**Camera**: Hold a wide meadow view, then ease toward both actors as they orient.

**Practical action**: Hold the arrival safe mark and face the nearest approved tree line; no Survival goal executes in this beat.

**Energetic action**: Hold the arrival safe mark and turn from the flowers back to Practical; no Survival goal executes in this beat.

**Dialogue**:

- Practical: “New world. Same sunset. Let us start with wood.”
- Energetic: “I was going to say flowers, but wood is harder to regret.”

Optional improvisation: one short reaction to an animal crossing the wide shot.

**Complete when**: The fixed arrival dialogue has authoritative completion while both actors remain at their safe marks.

**Recovery**: If either actor leaves frame, return to the arrival safe mark and retry.

## Beat 2 — First Priorities

**Cue ID**: `first_priorities`

**Camera**: Pan from the sinking sun to the two approved tree regions.

**Practical action**: Visually identify the practical tree region while holding position. No Survival action begins in this beat.

**Energetic action**: Visually identify the energetic tree region while holding position. No Survival action begins in this beat.

**Dialogue**:

- Energetic: “I found the best tree. It was the second one.”
- Practical: “Excellent. Keep revising until you have three logs.”

Optional improvisation: Energetic may confidently misname one flower, then self-correct.

**Complete when**: The fixed priorities dialogue has authoritative completion; no target is reserved and no gathering has begun.

**Recovery**: If either actor moves early, return to the safe mark and repeat only this dialogue beat.

## Beat 3 — Two Trees

**Cue ID**: `two_trees`

**Camera**: Use a wide two-shot when possible; cut only after a confirmed log break.

**Practical action**: After the dialogue completes, reserve a `nearest_reachable_oak_log` in the practical tree region, then `prepare -> execute -> observe -> confirm` each log and collect its drop.

**Energetic action**: After the dialogue completes, reserve a distinct reachable target, gather only from the energetic tree region, and pick up every confirmed drop.

**Dialogue**:

- Practical: “Three logs each, then meet at the flat stone.”
- Energetic: “Three. I can count trees when they cooperate.”

Optional improvisation: one reaction to a leaf block hiding the next log.

**Complete when**: Authoritative observation reports `inventory oak_log >= 3` for each actor.

**Recovery**: If a target moves or becomes unreachable, release it, choose an alternate target, and collect loose items.

## Beat 4 — Crafting

**Cue ID**: `crafting`

**Camera**: Regroup at the flat crafting mark with both hands and the placement cell visible.

**Practical action**: After the dialogue completes, regroup, `craft oak_planks`, craft sticks and one table from Practical's own inventory, `place crafting_table` at the approved mark, then `craft wooden_pickaxe` once and equip that tool from Practical's own inventory.

**Energetic action**: After the dialogue completes, regroup at the table, `craft oak_planks` and sticks from Energetic's own inventory, `craft wooden_pickaxe` once, then equip that tool from Energetic's own inventory.

**Dialogue**:

- Practical: “Crafting starts here. Try not to craft a door.”
- Energetic: “A door was not the plan. It was a possibility.”

Optional improvisation: Energetic may inspect the table once after placement confirmation.

**Complete when**: One crafting table is observed at the mark and authoritative observation reports one genuinely crafted wooden pickaxe in each actor's inventory and equipped in each actor's hand.

**Recovery**: Re-observe each actor's inventory and retry only that actor's unconfirmed recipe or equip step; never transfer or grant a tool.

## Beat 5 — Breaking Ground

**Cue ID**: `breaking_ground`

**Camera**: Follow both equipped actors to the entrance, then hold a wide angle across its two lanes.

**Practical action**: After the dialogue completes, excavate only approved stone cells in the first lane and collect each confirmed cobblestone drop.

**Energetic action**: After the dialogue completes, work only the second approved lane, never enter Practical's active target cell, and collect each confirmed cobblestone drop.

**Dialogue**:

- Practical: “Two pickaxes. One each. That avoids negotiations.”
- Energetic: “I accept mine and reject the implication.”

Optional improvisation: one dry comment if the pickaxes enter the wrong hotbar slots.

**Complete when**: Authoritative observation reports `Practical inventory cobblestone >= 6`, `Energetic inventory cobblestone >= 5`, and every mutation belongs to that actor's approved lane.

**Recovery**: On obstruction, reset both actors to the mine safe mark, choose the next approved cell, and resume without commands.

## Beat 6 — Hook

**Cue ID**: `hook`

**Camera**: Take an over-the-shoulder angle that keeps both actors and the entrance visible.

**Practical action**: Remain clear of the completed entrance and point the story toward shelter-building. No Survival goal executes in this beat.

**Energetic action**: React to coal or an animal while remaining beside Practical. No Survival goal executes in this beat.

**Dialogue**:

- Energetic: “Coal already? The meadow is showing off.”
- Practical: “Good. It can help with the shelter.”

Optional improvisation: add one brief animal reaction after both fixed lines if an animal crosses the shot; it never replaces either authored line.

**Complete when**: The hook dialogue has authoritative completion and the story has transitioned toward shelter; no additional movement, digging, or crafting is required.

**Recovery**: Reset to the mine safe mark and repeat both fixed hook lines; an animal reaction may follow, but it cannot replace or complete the exchange.
