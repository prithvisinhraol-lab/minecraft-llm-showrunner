import { ShowrunnerError } from './errors.mjs';

function fail(message, details = {}) {
  throw new ShowrunnerError('EPISODE_COMPOSITION_INVALID', message, details);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function sameOrderedStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameActors(showrunnerActors, survivalActors) {
  if (!showrunnerActors || !Array.isArray(survivalActors)) return false;
  const left = Object.keys(showrunnerActors).sort();
  const right = [...survivalActors].sort();
  return sameOrderedStrings(left, right);
}

function samePosition(left, right) {
  return left && right && ['x', 'y', 'z'].every((axis) => left[axis] === right[axis]);
}

export function validateEpisodeComposition(episode, survivalEpisode) {
  if (!episode || !survivalEpisode || ![1, 2].includes(episode.schemaVersion) ||
      survivalEpisode.schemaVersion !== episode.schemaVersion) {
    fail('Showrunner and Survival episodes must declare the same supported schema version');
  }
  if (!nonemptyString(episode.episode) || episode.episode !== survivalEpisode.episode) {
    fail('Showrunner and Survival episode ids must match', {
      showrunnerEpisode: episode?.episode,
      survivalEpisode: survivalEpisode?.episode
    });
  }
  if (!nonemptyString(episode.title) || episode.title !== survivalEpisode.title) {
    fail('Showrunner and Survival episode titles must match');
  }
  if (!sameActors(episode.actors, survivalEpisode.actors)) {
    fail('Showrunner and Survival actor sets must match exactly');
  }

  if (episode.schemaVersion === 1) {
    const cueGoalIds = episode.scene?.cues?.flatMap((cue) => cue.goalId === undefined ? [] : [cue.goalId]);
    if ((survivalEpisode.dialogueBoundaries?.length ?? 0) > 0 && cueGoalIds.length === 0) {
      fail('Schema-v1 Survival dialogue boundaries require authored goal_id cue bindings');
    }
    if (!sameOrderedStrings(cueGoalIds, survivalEpisode.dialogueBoundaries)) {
      fail('Schema-v1 goal_id cues must match Survival dialogue boundaries in authored order');
    }
    return Object.freeze({
      schemaVersion: 1,
      episodeId: episode.episode,
      goalIds: Object.freeze([...cueGoalIds])
    });
  }

  const cues = episode.scene?.cues;
  const beats = survivalEpisode.beats;
  const goals = survivalEpisode.goals;
  if (!Array.isArray(cues) || !Array.isArray(beats) || !Array.isArray(goals) ||
      cues.length !== 6 || beats.length !== 6) {
    fail('Schema-v2 composition requires exactly six matching cues and beats plus a goal manifest');
  }
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const beat = beats[index];
    if (!nonemptyString(cue?.id) || cue.survivalBeatId !== cue.id || beat?.id !== cue.id) {
      fail('Schema-v2 cue and beat identities must match in authored order', { index });
    }
    if (!sameOrderedStrings(cue.survivalGoalIds, beat.goalIds)) {
      fail('Schema-v2 cue goal ids must exactly match their Survival beat', { beatId: beat.id });
    }
  }
  const cueGoalIds = cues.flatMap((cue) => cue.survivalGoalIds);
  const authoredGoalIds = goals.map((goal) => goal.id);
  if (!sameOrderedStrings(cueGoalIds, authoredGoalIds)) {
    fail('Schema-v2 cues must partition every Survival goal exactly once in authored order');
  }

  for (const [markId, survivalMark] of Object.entries(survivalEpisode.marks ?? {})) {
    const showrunnerMark = episode.scene?.marks?.[markId];
    if (!showrunnerMark || !samePosition(showrunnerMark.position, survivalMark.position) ||
        showrunnerMark.safeHeadroom !== true || survivalMark.safeHeadroom !== true) {
      fail('Shared showrunner and Survival marks must have identical safe positions', { markId });
    }
  }

  return Object.freeze({
    schemaVersion: 2,
    episodeId: episode.episode,
    beatIds: Object.freeze(beats.map((beat) => beat.id)),
    goalIds: Object.freeze([...authoredGoalIds])
  });
}
