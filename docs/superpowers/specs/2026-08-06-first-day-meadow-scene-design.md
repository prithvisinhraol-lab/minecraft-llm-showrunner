# First Day in the Meadow Scene Design

Status: approved in conversation on 2026-08-06; written-spec review pending

## Goal

Create a short, filmable opening scene about two Minecraft players entering a new world together. The scene combines natural, lightly comedic dialogue with explicit cues for movement, looking, gathering wood, crafting starter tools, and beginning a mine.

## Deliverable

The first deliverable is a production script rather than a live executable episode. It will be stored as a Markdown shooting script so the creator can read and revise it easily. Each beat will contain:

- an approximate time window;
- blocking and camera direction;
- separate action cues for both characters;
- authored fallback dialogue plus bounded improvisation guidance;
- a completion condition that tells the showrunner when to advance;
- a recovery cue for common failures such as pathing around an animal or selecting the wrong block.

The script will not pretend that the current showrunner can already execute gathering and crafting. The current MVP supports marks, looking, and speech, while block mutation, gathering, and crafting are explicitly outside its implemented action surface. Executable mining and crafting require a later action-runtime extension.

## Scene and Tone

The set is a bright meadow with flowers, passive animals, open sight lines, and two nearby trees. The actors spawn several blocks apart, notice the world and one another, then divide the first-day work naturally.

The dialogue is family-friendly, concise, and lightly comedic. One character is practical and quietly competent; the other is curious, energetic, and slightly overconfident. Neither character narrates every button press. Dialogue reacts to discoveries and minor mistakes so it feels performed rather than instructional.

## Beat Structure

1. **Arrival:** Both characters orient themselves, notice the meadow, and establish their contrasting voices.
2. **First priorities:** They agree that night is the deadline and decide to gather wood.
3. **Two trees:** Each actor walks to a separate validated tree mark, faces a reachable log, and begins gathering.
4. **Crafting:** They regroup, convert logs to planks, place one crafting table, and make wooden pickaxes.
5. **Breaking ground:** They select a safe hillside or shallow ground mark, dig a two-wide entrance, and collect enough cobblestone for starter tools and a furnace.
6. **Hook:** A coal discovery or nearby animal interruption gives the scene a final joke and a clear transition into shelter-building.

## Cue Semantics

Movement cues name destinations instead of embedding fragile paths. Mining cues identify a target class, such as `nearest_reachable_oak_log`, plus a success condition, such as `inventory oak_log >= 3`. Crafting cues name recipes and required counts. Dialogue may run only at declared safe moments so speech does not interrupt a pathfinding or inventory transaction.

Each action uses the sequence `prepare -> execute -> observe -> confirm`. A beat advances only after authoritative observation confirms its completion condition. If an action times out, the recovery cue either chooses another nearby target or resets the actor to the beat's safe mark. No actor receives operator permissions or arbitrary command access.

## Dialogue Guidance

Every required exchange has authored lines that preserve the story beat. Optional variants may change wording while retaining intent and the characters' voices. Live improvisation, if enabled later, is limited to reaction lines and cannot advance the beat.

Lines should generally remain under 16 words. The practical character uses dry understatement and task-focused observations. The energetic character uses confident guesses, quick reactions, and occasional harmless self-correction. Avoid tutorials, modern internet slang, insults, and references to being an AI or following a script.

## Recording Direction

The script assumes the creator records a first-person view while the showrunner controls the two actors. Camera notes are advisory and separate from actor commands. The opening holds long enough to establish the meadow; tree gathering uses a wider composition when possible; the mine entrance uses an over-the-shoulder or side angle that keeps both actors visible.

## Validation

The written script is complete when every beat has dialogue, actor cues, completion conditions, and recovery behavior, and when the whole scene has a clear beginning, progression, and ending hook. Before live execution, the future runtime extension must test movement, log targeting, block breaking, recipe crafting, inventory checks, cooperative target reservation, cancellation, and reset behavior.

