import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBaselineManifest, loadEpisode, loadProfile } from '../src/showrunner/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'showrunner');
const meadowEpisodePath = path.join(here, '..', 'production', 'episodes', 'first-day-meadow.yaml');
const productionPath = path.join(here, '..', 'production');

function fixture(name) {
  return path.join(fixtures, name);
}

async function copyFixtureTree(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-schema-'));
  await cp(fixtures, directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function copyProductionTree(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-production-schema-'));
  await cp(productionPath, path.join(directory, 'production'), { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'production', 'episodes');
}

function runCli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/showrunner/cli.mjs', ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('loads the two-actor episode and resolves referenced assets', async () => {
  const episode = await loadEpisode(fixture('valid-episode.yaml'));

  assert.equal(episode.schemaVersion, 1);
  assert.deepEqual(Object.keys(episode.actors), ['hero', 'rival']);
  assert.equal(episode.scene.cues.length, 2);
  assert.equal(episode.scene.marks.hero_start.dimension, 'minecraft:overworld');
  assert.equal(episode.actors.hero.profile.actor, 'hero');
  assert.equal(episode.set.baselineManifest.setId, 'city_square_dialogue');
  assert.equal(Object.isFrozen(episode), true);
  assert.equal(episode.sourcePath.endsWith('valid-episode.yaml'), true);
});

test('loads the schema-v2 meadow as six ordered two-line exchanges with authored goal identities', async () => {
  const episode = await loadEpisode(meadowEpisodePath);

  assert.equal(episode.schemaVersion, 2);
  assert.deepEqual(episode.scene.cues.map(({ id, survivalBeatId }) => ({ id, survivalBeatId })), [
    'arrival', 'first_priorities', 'two_trees', 'crafting', 'breaking_ground', 'hook'
  ].map((id) => ({ id, survivalBeatId: id })));
  assert.deepEqual(episode.scene.cues.flatMap(({ survivalGoalIds }) => survivalGoalIds), [
    'gather_hero_logs', 'gather_rival_logs',
    'regroup_hero_at_crafting_table', 'regroup_rival_at_crafting_table', 'place_crafting_table',
    'craft_hero_wooden_pickaxe', 'craft_rival_wooden_pickaxe',
    'equip_hero_wooden_pickaxe', 'equip_rival_wooden_pickaxe',
    'excavate_hero_lane', 'excavate_rival_lane'
  ]);
  assert.deepEqual(episode.scene.cues.map(({ id, dialogue }) => ({
    id,
    lines: dialogue.map(({ id: lineId, cueId, speaker, fallbackLine }) => ({ lineId, cueId, speaker, fallbackLine }))
  })), [
    {
      id: 'arrival',
      lines: [
        { lineId: 'arrival_practical', cueId: 'arrival', speaker: 'hero', fallbackLine: 'New world. Same sunset. Let us start with wood.' },
        { lineId: 'arrival_energetic', cueId: 'arrival', speaker: 'rival', fallbackLine: 'I was going to say flowers, but wood is harder to regret.' }
      ]
    },
    {
      id: 'first_priorities',
      lines: [
        { lineId: 'first_priorities_energetic', cueId: 'first_priorities', speaker: 'rival', fallbackLine: 'I found the best tree. It was the second one.' },
        { lineId: 'first_priorities_practical', cueId: 'first_priorities', speaker: 'hero', fallbackLine: 'Excellent. Keep revising until you have three logs.' }
      ]
    },
    {
      id: 'two_trees',
      lines: [
        { lineId: 'two_trees_practical', cueId: 'two_trees', speaker: 'hero', fallbackLine: 'Three logs each, then meet at the flat stone.' },
        { lineId: 'two_trees_energetic', cueId: 'two_trees', speaker: 'rival', fallbackLine: 'Three. I can count trees when they cooperate.' }
      ]
    },
    {
      id: 'crafting',
      lines: [
        { lineId: 'crafting_practical', cueId: 'crafting', speaker: 'hero', fallbackLine: 'Crafting starts here. Try not to craft a door.' },
        { lineId: 'crafting_energetic', cueId: 'crafting', speaker: 'rival', fallbackLine: 'A door was not the plan. It was a possibility.' }
      ]
    },
    {
      id: 'breaking_ground',
      lines: [
        { lineId: 'breaking_ground_practical', cueId: 'breaking_ground', speaker: 'hero', fallbackLine: 'Two pickaxes. One each. That avoids negotiations.' },
        { lineId: 'breaking_ground_energetic', cueId: 'breaking_ground', speaker: 'rival', fallbackLine: 'I accept mine and reject the implication.' }
      ]
    },
    {
      id: 'hook',
      lines: [
        { lineId: 'hook_energetic', cueId: 'hook', speaker: 'rival', fallbackLine: 'Coal already? The meadow is showing off.' },
        { lineId: 'hook_practical', cueId: 'hook', speaker: 'hero', fallbackLine: 'Good. It can help with the shelter.' }
      ]
    }
  ]);
  assert.equal(episode.scene.cues.every(({ dialogue }) => Object.isFrozen(dialogue)), true);
  assert.equal(Object.isFrozen(episode.scene.cues[0].survivalGoalIds), true);
});

test('reserves beat bindings for schema v2 while schema v1 retains only goal_id', async (t) => {
  const directory = await copyFixtureTree(t);
  const beatPath = path.join(directory, 'beat-bound.yaml');
  const beatGoalsPath = path.join(directory, 'beat-goals-bound.yaml');
  const goalPath = path.join(directory, 'goal-bound.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(beatPath, valid.replace('    - id: rival_reveal\n', '    - id: rival_reveal\n      survival_beat_id: arrival\n'));
  await writeFile(beatGoalsPath, valid.replace('    - id: rival_reveal\n', '    - id: rival_reveal\n      survival_goal_ids: [gather_logs]\n'));
  await writeFile(goalPath, valid.replace('    - id: rival_reveal\n', '    - id: rival_reveal\n      goal_id: gather_logs\n'));

  assert.equal((await loadEpisode(goalPath)).scene.cues[0].goalId, 'gather_logs');
  await assert.rejects(loadEpisode(beatPath), { code: 'EPISODE_SCHEMA_INVALID' });
  await assert.rejects(loadEpisode(beatGoalsPath), { code: 'EPISODE_SCHEMA_INVALID' });
});

test('reports YAML source location and rejects unsafe or missing mark fields', async () => {
  await assert.rejects(loadEpisode(fixture('invalid-mark.yaml')), (error) => {
    assert.equal(error.code, 'EPISODE_SCHEMA_INVALID');
    assert.equal(error.details.path.endsWith('invalid-mark.yaml'), true);
    assert.equal(Number.isInteger(error.details.line), true);
    assert.equal(Number.isInteger(error.details.column), true);
    assert.equal(error.details.line, 15);
    assert.equal(error.details.column, 5);
    return true;
  });
});

test('reports the actual repeated field occurrence and parser-reported syntax location', async (t) => {
  const directory = await copyFixtureTree(t);
  const speakerPath = path.join(directory, 'second-speaker-invalid.yaml');
  const duplicatePath = path.join(directory, 'duplicate-key.yaml');
  const syntaxPath = path.join(directory, 'syntax-error.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(speakerPath, valid.replace('speaker: hero', 'speaker: narrator'));
  await writeFile(duplicatePath, valid.replace('episode: stolen_map', 'episode: stolen_map\nepisode: duplicate'));
  await writeFile(syntaxPath, 'schema_version: 1\nactors: [hero, rival\n');

  await assert.rejects(loadEpisode(speakerPath), (error) => {
    assert.equal(error.code, 'EPISODE_SCHEMA_INVALID');
    assert.equal(error.details.line, 43);
    assert.equal(error.details.column, 16);
    return true;
  });
  await assert.rejects(loadEpisode(duplicatePath), (error) => {
    assert.equal(error.code, 'EPISODE_YAML_INVALID');
    assert.equal(error.details.line, 3);
    assert.equal(error.details.column, 1);
    return true;
  });
  await assert.rejects(loadEpisode(syntaxPath), (error) => {
    assert.equal(error.code, 'EPISODE_YAML_INVALID');
    assert.equal(error.details.line, 3);
    assert.equal(error.details.column, 1);
    return true;
  });
});

test('rejects a mark that declares its required headroom unsafe', async (t) => {
  const directory = await copyFixtureTree(t);
  const episodePath = path.join(directory, 'unsafe-headroom.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(episodePath, valid.replace('safe_headroom: true', 'safe_headroom: false'));

  await assert.rejects(loadEpisode(episodePath), { code: 'EPISODE_SCHEMA_INVALID' });
});

test('rejects unsupported schema versions and actor counts other than two', async (t) => {
  const directory = await copyFixtureTree(t);
  const versionPath = path.join(directory, 'invalid-version.yaml');
  const actorPath = path.join(directory, 'invalid-actors.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(versionPath, valid.replace('schema_version: 1', 'schema_version: 3'));
  await writeFile(actorPath, valid.replace('  rival: profiles/rival.yaml\n', ''));

  await assert.rejects(loadEpisode(versionPath), { code: 'EPISODE_SCHEMA_INVALID' });
  await assert.rejects(loadEpisode(actorPath), { code: 'EPISODE_SCHEMA_INVALID' });
});

test('rejects schema-v2 cues that are not an exact six-cue beat manifest', async (t) => {
  const directory = await copyFixtureTree(t);
  const production = await readFile(meadowEpisodePath, 'utf8');
  const missingCuePath = path.join(directory, 'v2-five-cues.yaml');
  const mismatchedBeatPath = path.join(directory, 'v2-mismatched-beat.yaml');
  const missingGoalsPath = path.join(directory, 'v2-missing-goals.yaml');
  await writeFile(missingCuePath, production.replace(/\n    - id: hook[\s\S]*?(?=\nretry:)/, ''));
  await writeFile(mismatchedBeatPath, production.replace('survival_beat_id: arrival', 'survival_beat_id: spoofed'));
  await writeFile(missingGoalsPath, production.replace('      survival_goal_ids: []\n', ''));

  for (const sourcePath of [missingCuePath, mismatchedBeatPath, missingGoalsPath]) {
    await assert.rejects(loadEpisode(sourcePath), { code: 'EPISODE_SCHEMA_INVALID' });
  }
});

test('rejects cue counts outside the two to three cue range and duplicate cue ids', async (t) => {
  const directory = await copyFixtureTree(t);
  const oneCuePath = path.join(directory, 'one-cue.yaml');
  const duplicatePath = path.join(directory, 'duplicate-cue.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(oneCuePath, valid.replace(/\n    - id: hero_reply[\s\S]*?(?=\nretry:)/, ''));
  await writeFile(duplicatePath, valid.replace('id: hero_reply', 'id: rival_reveal'));

  await assert.rejects(loadEpisode(oneCuePath), { code: 'EPISODE_SCHEMA_INVALID' });
  await assert.rejects(loadEpisode(duplicatePath), { code: 'EPISODE_SCHEMA_INVALID' });
});

test('rejects unknown cue speakers and marks', async (t) => {
  const directory = await copyFixtureTree(t);
  const speakerPath = path.join(directory, 'unknown-speaker.yaml');
  const markPath = path.join(directory, 'unknown-mark.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(speakerPath, valid.replace('speaker: rival', 'speaker: narrator'));
  await writeFile(markPath, valid.replace('mark: rival_start', 'mark: absent_mark'));

  await assert.rejects(loadEpisode(speakerPath), { code: 'EPISODE_SCHEMA_INVALID' });
  await assert.rejects(loadEpisode(markPath), { code: 'EPISODE_SCHEMA_INVALID' });
});

test('rejects nonpositive mark radius, dwell, and cue timeout', async (t) => {
  const directory = await copyFixtureTree(t);
  const radiusPath = path.join(directory, 'zero-radius.yaml');
  const dwellPath = path.join(directory, 'zero-dwell.yaml');
  const timeoutPath = path.join(directory, 'zero-timeout.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(radiusPath, valid.replace('radius: 0.8', 'radius: 0'));
  await writeFile(dwellPath, valid.replace('dwell_ticks: 10', 'dwell_ticks: 0'));
  await writeFile(timeoutPath, valid.replace('timeout_seconds: 12', 'timeout_seconds: 0'));

  await assert.rejects(loadEpisode(radiusPath), { code: 'EPISODE_SCHEMA_INVALID' });
  await assert.rejects(loadEpisode(dwellPath), { code: 'EPISODE_SCHEMA_INVALID' });
  await assert.rejects(loadEpisode(timeoutPath), { code: 'EPISODE_SCHEMA_INVALID' });
});

test('rejects unsupported whole-scene attempts and writable action fields', async (t) => {
  const directory = await copyFixtureTree(t);
  const attemptsPath = path.join(directory, 'invalid-attempts.yaml');
  const actionPath = path.join(directory, 'writable-action.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(attemptsPath, valid.replace('whole_scene_attempts: 2', 'whole_scene_attempts: 3'));
  await writeFile(actionPath, valid.replace('retry:\n', 'writable_actions: ["/setblock ~ ~ ~ stone"]\nretry:\n'));

  await assert.rejects(loadEpisode(attemptsPath), { code: 'EPISODE_SCHEMA_INVALID' });
  await assert.rejects(loadEpisode(actionPath), { code: 'EPISODE_SCHEMA_INVALID' });
});

test('requires the MVP dialogue policy to forbid overlap', async (t) => {
  const directory = await copyFixtureTree(t);
  const episodePath = path.join(directory, 'overlap-enabled.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(episodePath, valid.replace('allow_overlap: false', 'allow_overlap: true'));

  await assert.rejects(loadEpisode(episodePath), { code: 'EPISODE_SCHEMA_INVALID' });
});

test('reports missing referenced profiles and manifests distinctly', async (t) => {
  const directory = await copyFixtureTree(t);
  const profilePath = path.join(directory, 'missing-profile.yaml');
  const manifestPath = path.join(directory, 'missing-manifest.yaml');
  const valid = await readFile(path.join(directory, 'valid-episode.yaml'), 'utf8');
  await writeFile(profilePath, valid.replace('profiles/hero.yaml', 'profiles/missing.yaml'));
  await writeFile(manifestPath, valid.replace('sets/city-square-dialogue.v1.json', 'sets/missing.json'));

  await assert.rejects(loadEpisode(profilePath), { code: 'EPISODE_REFERENCE_INVALID' });
  await assert.rejects(loadEpisode(manifestPath), { code: 'EPISODE_REFERENCE_INVALID' });
});

test('loads strict profile and baseline documents with normalized keys', async () => {
  const profile = await loadProfile(fixture('profiles/hero.yaml'));
  const manifest = await loadBaselineManifest(fixture('sets/city-square-dialogue.v1.json'));

  assert.equal(profile.maxLineWords, 18);
  assert.equal(profile.rehearsal.maxCandidates, 3);
  assert.equal(profile.rehearsal.provider, 'openai');
  assert.equal(profile.rehearsal.model, 'rehearsal-model');
  assert.equal(profile.rehearsal.runtimeUse, false);
  assert.equal(manifest.protectedCuboid.min.x, 528);
  assert.equal(manifest.blockAssertions[0].verification, 'authored_unverified');
  assert.equal(manifest.resetTimeoutMs, 10_000);
  assert.equal(manifest.sourcePath.endsWith('city-square-dialogue.v1.json'), true);
});

test('requires a bounded reset timeout in baseline manifests', async (t) => {
  const directory = await copyFixtureTree(t);
  const manifestPath = path.join(directory, 'sets', 'city-square-dialogue.v1.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.reset_timeout_ms = 0;
  await writeFile(manifestPath, JSON.stringify(manifest));

  await assert.rejects(loadBaselineManifest(manifestPath), { code: 'BASELINE_MANIFEST_INVALID' });
});

test('requires profiles to declare a rehearsal-only provider and model configuration', async (t) => {
  const directory = await copyFixtureTree(t);
  const profilePath = path.join(directory, 'profiles', 'runtime-profile.yaml');
  const missingPath = path.join(directory, 'profiles', 'missing-runtime-profile.yaml');
  const valid = await readFile(path.join(directory, 'profiles', 'hero.yaml'), 'utf8');
  await writeFile(profilePath, valid.replace('  runtime_use: false\n', '  runtime_use: true\n'));
  await writeFile(missingPath, valid.replace('  runtime_use: false\n', ''));

  await assert.rejects(loadProfile(profilePath), { code: 'PROFILE_SCHEMA_INVALID' });
  await assert.rejects(loadProfile(missingPath), { code: 'PROFILE_SCHEMA_INVALID' });
});

test('rejects unknown baseline actor fields and actor sets that differ from the episode', async (t) => {
  const directory = await copyFixtureTree(t);
  const manifestPath = path.join(directory, 'sets', 'city-square-dialogue.v1.json');
  const episodePath = path.join(directory, 'valid-episode.yaml');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  manifest.actor_baselines.hero.teleport_command = '/tp hero 0 0 0';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadBaselineManifest(manifestPath), { code: 'BASELINE_MANIFEST_INVALID' });

  delete manifest.actor_baselines.hero.teleport_command;
  manifest.actor_baselines.extra = manifest.actor_baselines.hero;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadEpisode(episodePath), { code: 'EPISODE_REFERENCE_INVALID' });

  delete manifest.actor_baselines.extra;
  delete manifest.actor_baselines.rival;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadEpisode(episodePath), { code: 'EPISODE_REFERENCE_INVALID' });
});

test('direct baseline loading requires exactly two actor entries', async (t) => {
  const directory = await copyFixtureTree(t);
  const manifestPath = path.join(directory, 'sets', 'city-square-dialogue.v1.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.actor_baselines.extra = manifest.actor_baselines.hero;
  await writeFile(manifestPath, JSON.stringify(manifest));

  await assert.rejects(loadBaselineManifest(manifestPath), { code: 'BASELINE_MANIFEST_INVALID' });
});

test('requires exactly restorable max health and food in every actor baseline', async (t) => {
  for (const [field, value] of [['health', 19], ['food', 19]]) {
    await t.test(field, async () => {
      const directory = await copyFixtureTree(t);
      const manifestPath = path.join(directory, 'sets', 'city-square-dialogue.v1.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.actor_baselines.hero[field] = value;
      await writeFile(manifestPath, JSON.stringify(manifest));
      await assert.rejects(loadBaselineManifest(manifestPath), { code: 'BASELINE_MANIFEST_INVALID' });
    });
  }
});

test('requires the daylight cycle disabled in baseline manifests', async (t) => {
  for (const mode of ['enabled', 'missing']) {
    await t.test(mode, async () => {
      const directory = await copyFixtureTree(t);
      const manifestPath = path.join(directory, 'sets', 'city-square-dialogue.v1.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (mode === 'enabled') manifest.environment.gamerules.doDaylightCycle = true;
      else delete manifest.environment.gamerules.doDaylightCycle;
      await writeFile(manifestPath, JSON.stringify(manifest));
      await assert.rejects(loadBaselineManifest(manifestPath), { code: 'BASELINE_MANIFEST_INVALID' });
    });
  }
});

test('validate command prints every resolved production source', async () => {
  const run = await runCli('validate', 'production/episodes/stolen-map.yaml');

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Episode: .*stolen-map\.yaml/);
  assert.match(run.stdout, /Profile \(hero\): .*hero\.yaml/);
  assert.match(run.stdout, /Profile \(rival\): .*rival\.yaml/);
  assert.match(run.stdout, /Baseline manifest: .*city-square-dialogue\.v1\.json/);
});

test('CLI jointly validates schema-v2 episode identity and the exact cross-file cue-goal partition', async (t) => {
  const partitionDirectory = await copyProductionTree(t);
  const partitionEpisodePath = path.join(partitionDirectory, 'first-day-meadow.yaml');
  const partitionSource = await readFile(partitionEpisodePath, 'utf8');
  await writeFile(partitionEpisodePath, partitionSource.replace(
    'survival_goal_ids: [gather_hero_logs, gather_rival_logs]',
    'survival_goal_ids: [gather_rival_logs, gather_hero_logs]'
  ));

  const partitionRun = await runCli('validate', partitionEpisodePath);
  assert.equal(partitionRun.code, 1, partitionRun.stdout);
  assert.match(partitionRun.stderr, /EPISODE_COMPOSITION_INVALID/);

  const identityDirectory = await copyProductionTree(t);
  const survivalPath = path.join(identityDirectory, 'first-day-meadow.survival.yaml');
  const survivalSource = await readFile(survivalPath, 'utf8');
  await writeFile(survivalPath, survivalSource.replace('episode: first_day_meadow', 'episode: wrong_episode'));

  const identityRun = await runCli('validate', survivalPath);
  assert.equal(identityRun.code, 1, identityRun.stdout);
  assert.match(identityRun.stderr, /EPISODE_COMPOSITION_INVALID/);
});

test('CLI jointly validates schema-v1 episodes that author goal_id bindings', async (t) => {
  const directory = await copyProductionTree(t);
  const episodePath = path.join(directory, 'stolen-map.yaml');
  const episodeSource = await readFile(episodePath, 'utf8');
  await writeFile(episodePath, episodeSource.replace(
    '    - id: rival_reveal\n      speaker:',
    '    - id: rival_reveal\n      goal_id: gather_hero_logs\n      speaker:'
  ));

  const meadowSurvivalPath = path.join(directory, 'first-day-meadow.survival.yaml');
  const survivalSource = await readFile(meadowSurvivalPath, 'utf8');
  const legacySource = survivalSource
    .replace('schema_version: 2', 'schema_version: 1')
    .replace('episode: first_day_meadow', 'episode: stolen_map')
    .replace('title: First Day in the Meadow', 'title: The Stolen Map')
    .replace(/    allowed_cells:\n(?:      - \{[^\n]+\}\n){6}/, '')
    .replace(/    allowed_cells:\n(?:      - \{[^\n]+\}\n){5}/, '')
    .replace(/beats:\n[\s\S]*?\ngoals:\n/, 'dialogue_boundaries: [gather_rival_logs]\ngoals:\n');
  const survivalPath = path.join(directory, 'stolen-map.survival.yaml');
  await writeFile(survivalPath, legacySource);

  for (const sourcePath of [episodePath, survivalPath]) {
    const run = await runCli('validate', sourcePath);
    assert.equal(run.code, 1, run.stdout);
    assert.match(run.stderr, /EPISODE_COMPOSITION_INVALID/);
  }
});

test('CLI preserves standalone schema-v1 Survival validation when no dialogue boundary is authored', async (t) => {
  const directory = await copyProductionTree(t);
  const meadowSurvivalPath = path.join(directory, 'first-day-meadow.survival.yaml');
  const survivalSource = await readFile(meadowSurvivalPath, 'utf8');
  const legacySource = survivalSource
    .replace('schema_version: 2', 'schema_version: 1')
    .replace(/    allowed_cells:\n(?:      - \{[^\n]+\}\n){6}/, '')
    .replace(/    allowed_cells:\n(?:      - \{[^\n]+\}\n){5}/, '')
    .replace(/beats:\n[\s\S]*?\ngoals:\n/, 'dialogue_boundaries: []\ngoals:\n');
  const survivalPath = path.join(directory, 'standalone.survival.yaml');
  await writeFile(survivalPath, legacySource);

  const run = await runCli('validate', survivalPath);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Normalized Survival goals: 11/);
});

test('CLI distinguishes validation failures from security-check failures', async () => {
  const validation = await runCli('validate', 'production/episodes/missing.yaml');
  const security = await runCli('security-check');

  assert.equal(validation.code, 1);
  assert.match(validation.stderr, /^SHOWRUNNER_VALIDATION_FAILED /);
  assert.equal(security.code, 1);
  assert.match(security.stderr, /^SHOWRUNNER_SECURITY_CHECK_FAILED /);
});
