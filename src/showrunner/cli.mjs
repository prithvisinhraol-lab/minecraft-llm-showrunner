import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { sourceEpisodeHash, verifyApprovedBank } from './approved-bank.mjs';
import { validateEpisodeComposition } from './episode-composition.mjs';
import { ERROR_CODES, ShowrunnerError } from './errors.mjs';
import { loadEpisode } from './schema.mjs';
import { applyOperatorMigration, planOperatorMigration } from './security.mjs';
import { loadSurvivalEpisode } from './survival-schema.mjs';

const COMMANDS = new Set([
  'validate', 'rehearse', 'run', 'recording-ready', 'recording-stopped', 'accept', 'reject', 'security-check'
]);

function coded(code, message = code, details = {}) {
  return new ShowrunnerError(code, message, details);
}

function printHelp(stdout = console.log) {
  stdout('Usage: node src/showrunner/cli.mjs validate <episode-path>');
  stdout('       node src/showrunner/cli.mjs rehearse <episode-path>');
  stdout('       node src/showrunner/cli.mjs run <episode-path> --bank <approved-bank-path>');
  stdout('       node src/showrunner/cli.mjs recording-ready --take <take-id> --path <recording-path>');
  stdout('       node src/showrunner/cli.mjs recording-stopped --take <take-id> --path <recording-path>');
  stdout('       node src/showrunner/cli.mjs accept --take <take-id>');
  stdout('       node src/showrunner/cli.mjs reject --take <take-id>');
  stdout('       node src/showrunner/cli.mjs security-check --actors <name,...> --controller <name> [--ops-path <path>] --dry-run');
  stdout('       node src/showrunner/cli.mjs security-check --actors <name,...> --controller <name> [--ops-path <path>] --apply-live');
  stdout('Safety: changing any ops.json requires the explicit --apply-live flag.');
  stdout('Live commands require a production host with rooted no-follow artifact I/O; acceptance additionally requires rooted no-follow recording-host opens.');
}

function parseArguments(args, { positionals = 0, values = [], flags = [] } = {}) {
  const valueNames = new Set(values);
  const flagNames = new Set(flags);
  const parsed = { positionals: [], values: {}, flags: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      parsed.positionals.push(argument);
      continue;
    }
    if (flagNames.has(argument)) {
      if (parsed.flags.has(argument)) throw coded('DUPLICATE_CLI_OPTION', `Duplicate option: ${argument}`);
      parsed.flags.add(argument);
      continue;
    }
    if (!valueNames.has(argument)) throw coded('UNKNOWN_CLI_OPTION', `Unknown option: ${argument}`);
    if (Object.hasOwn(parsed.values, argument)) throw coded('DUPLICATE_CLI_OPTION', `Duplicate option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw coded('MISSING_OPTION_VALUE', `Missing value for ${argument}`);
    parsed.values[argument] = value;
    index += 1;
  }
  if (parsed.positionals.length !== positionals) throw coded('CLI_POSITIONAL_ARGUMENT_INVALID');
  return parsed;
}

function requiredOption(parsed, option, code) {
  const value = parsed.values[option];
  if (typeof value !== 'string' || value.length === 0) throw coded(code);
  return value;
}

function hasSurvivalBindings(episode) {
  return episode?.schemaVersion === 2 || (episode?.schemaVersion === 1 &&
    episode.scene?.cues?.some((cue) => cue.goalId !== undefined));
}

function optionsFromSecurityArgs(parsed) {
  const actorNames = (parsed.values['--actors']
    ?? [process.env.SHOWRUNNER_HERO_USERNAME, process.env.SHOWRUNNER_RIVAL_USERNAME]
      .filter(Boolean)
      .join(','))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const controllerName = parsed.values['--controller'] ?? process.env.SHOWRUNNER_CONTROLLER_NAME;

  if (actorNames.length === 0) throw coded('ACTOR_NAMES_REQUIRED');
  if (!controllerName) throw coded('CONTROLLER_NAME_REQUIRED');
  return { actorNames, controllerName };
}

function assertLevelFourController(controller) {
  if (controller.level !== 4) throw coded('CONTROLLER_NOT_LEVEL_4');
}

async function runSecurityCheck(args, { stdout, readText }) {
  const parsed = parseArguments(args, {
    values: ['--actors', '--controller', '--ops-path'],
    flags: ['--dry-run', '--apply-live']
  });
  const options = optionsFromSecurityArgs(parsed);
  const opsPath = path.resolve(parsed.values['--ops-path'] ?? 'server/ops.json');
  const dryRun = parsed.flags.has('--dry-run');

  if (dryRun && parsed.flags.has('--apply-live')) throw coded('CONFLICTING_APPLY_MODE');
  if (dryRun) {
    const entries = JSON.parse(await readText(opsPath, 'utf8'));
    if (!Array.isArray(entries)) throw coded('INVALID_OPS_FILE');
    const result = planOperatorMigration(entries, options);
    assertLevelFourController(result.controller);
    stdout(`Dry-run actor removals: ${result.removedActors.join(', ') || '(none)'}`);
    stdout(`Dry-run controller confirmed: ${result.controller.name} (level ${result.controller.level})`);
    stdout('Dry-run complete: ops.json was not changed.');
    return result;
  }

  if (!parsed.flags.has('--apply-live')) {
    throw coded('APPLY_LIVE_REQUIRED', 'Refusing to change ops.json without --apply-live');
  }
  const { backupPath, result } = await applyOperatorMigration(opsPath, options);
  stdout(`Removed actor ops: ${result.removedActors.join(', ') || '(none)'}`);
  stdout(`Controller confirmed: ${result.controller.name} (level ${result.controller.level})`);
  stdout(`Backup written: ${backupPath}`);
  return { backupPath, result };
}

async function runValidate(args, { stdout }) {
  let parsed;
  try {
    parsed = parseArguments(args, { positionals: 1 });
  } catch (error) {
    if (error?.code === 'CLI_POSITIONAL_ARGUMENT_INVALID') throw coded(ERROR_CODES.EPISODE_PATH_REQUIRED);
    throw error;
  }
  const episodePath = parsed.positionals[0];
  if (/\.survival\.ya?ml$/u.test(episodePath)) {
    const survivalEpisode = await loadSurvivalEpisode(episodePath);
    stdout(`Episode: ${survivalEpisode.sourcePath}`);
    stdout(`Survival actors: ${survivalEpisode.actors.join(', ')}`);
    if (survivalEpisode.beats) stdout(`Visible Survival beats: ${survivalEpisode.beats.length}`);
    stdout(`Normalized Survival goals: ${survivalEpisode.goals.length}`);
    if (survivalEpisode.schemaVersion === 2 || survivalEpisode.dialogueBoundaries.length > 0) {
      const showrunnerPath = episodePath.replace(/\.survival(\.ya?ml)$/u, '$1');
      const showrunnerEpisode = await loadEpisode(showrunnerPath);
      validateEpisodeComposition(showrunnerEpisode, survivalEpisode);
      stdout(`Showrunner episode: ${showrunnerEpisode.sourcePath}`);
      stdout('Cross-file composition: valid');
    }
    return survivalEpisode;
  }
  const episode = await loadEpisode(episodePath);
  stdout(`Episode: ${episode.sourcePath}`);
  for (const [actor, value] of Object.entries(episode.actors)) stdout(`Profile (${actor}): ${value.profile.sourcePath}`);
  stdout(`Baseline manifest: ${episode.set.baselineManifest.sourcePath}`);
  if (hasSurvivalBindings(episode)) {
    const survivalPath = episodePath.replace(/(\.ya?ml)$/u, '.survival$1');
    const survivalEpisode = await loadSurvivalEpisode(survivalPath);
    validateEpisodeComposition(episode, survivalEpisode);
    stdout(`Survival episode: ${survivalEpisode.sourcePath}`);
    stdout('Cross-file composition: valid');
  }
  return episode;
}

async function loadRunnableEpisode(episodePath) {
  const episode = await loadEpisode(episodePath);
  if (!hasSurvivalBindings(episode)) return { episode };
  const survivalPath = episodePath.replace(/(\.ya?ml)$/u, '.survival$1');
  const survivalEpisode = await loadSurvivalEpisode(survivalPath);
  validateEpisodeComposition(episode, survivalEpisode);
  return { episode, survivalEpisode };
}

function productionMethod(dependencies, name) {
  const method = dependencies.productionHost?.[name];
  if (typeof method !== 'function') {
    throw coded('LIVE_ADAPTER_NOT_CONFIGURED', `Production host must implement ${name}()`);
  }
  return method.bind(dependencies.productionHost);
}

async function runRehearse(args, dependencies) {
  let parsed;
  try {
    parsed = parseArguments(args, { positionals: 1 });
  } catch (error) {
    if (error?.code === 'CLI_POSITIONAL_ARGUMENT_INVALID') throw coded(ERROR_CODES.EPISODE_PATH_REQUIRED);
    throw error;
  }
  const { episode, survivalEpisode } = await loadRunnableEpisode(parsed.positionals[0]);
  return productionMethod(dependencies, 'rehearse')({
    episode,
    ...(survivalEpisode === undefined ? {} : { survivalEpisode }),
    episodePath: episode.sourcePath
  });
}

async function loadApprovedBank(bankPath, readText) {
  let bank;
  try {
    bank = JSON.parse(await readText(bankPath, 'utf8'));
  } catch (cause) {
    if (cause?.code === 'ENOENT') throw coded('APPROVED_BANK_INVALID', `Unable to read ${bankPath}`);
    if (cause instanceof SyntaxError) throw coded('APPROVED_BANK_INVALID', `Invalid JSON in ${bankPath}`);
    throw cause;
  }
  const verification = verifyApprovedBank(bank);
  if (verification.ok !== true) throw coded(verification.code, verification.code);
  return bank;
}

async function runTake(args, dependencies) {
  let parsed;
  try {
    parsed = parseArguments(args, { positionals: 1, values: ['--bank'] });
  } catch (error) {
    if (error?.code === 'CLI_POSITIONAL_ARGUMENT_INVALID') throw coded(ERROR_CODES.EPISODE_PATH_REQUIRED);
    throw error;
  }
  const episodePath = parsed.positionals[0];
  const bankPath = requiredOption(parsed, '--bank', 'APPROVED_BANK_REQUIRED');
  const { episode, survivalEpisode } = await loadRunnableEpisode(episodePath);
  const bank = await loadApprovedBank(bankPath, dependencies.readText);
  if (bank.sourceEpisodeHash !== sourceEpisodeHash(episode)) {
    throw coded('APPROVED_BANK_EPISODE_MISMATCH');
  }
  const result = await productionMethod(dependencies, 'run')({
    episode,
    ...(survivalEpisode === undefined ? {} : { survivalEpisode }),
    bank,
    episodePath: episode.sourcePath,
    bankPath: path.resolve(bankPath)
  });
  if (result?.takeId) dependencies.stdout(`Take ID: ${result.takeId}`);
  return result;
}

async function runRecordingAcknowledgement(command, args, dependencies) {
  const parsed = parseArguments(args, { values: ['--take', '--path'] });
  const takeId = requiredOption(parsed, '--take', 'TAKE_ID_REQUIRED');
  const recordingPath = requiredOption(parsed, '--path', 'RECORDING_PATH_REQUIRED');
  const method = command === 'recording-ready' ? 'recordingReady' : 'recordingStopped';
  return productionMethod(dependencies, method)({ takeId, path: recordingPath });
}

async function inspectCompletedTake(takeId, dependencies) {
  const take = await productionMethod(dependencies, 'inspectTake')({ takeId });
  if (take?.status !== 'completed') throw coded('TAKE_NOT_COMPLETED');
  return take;
}

async function runDecision(command, args, dependencies) {
  const parsed = parseArguments(args, { values: ['--take'] });
  const takeId = requiredOption(parsed, '--take', 'TAKE_ID_REQUIRED');
  await inspectCompletedTake(takeId, dependencies);

  if (command === 'accept') {
    if (typeof dependencies.recordingHost?.openBeneath !== 'function') throw coded('ROOTED_OPEN_REQUIRED');
    const verification = await productionMethod(dependencies, 'verifyCapture')({
      takeId,
      fsPort: dependencies.recordingHost
    });
    if (verification?.ok !== true) {
      throw coded('CAPTURE_VERIFICATION_REQUIRED', 'Capture verification failed', { reason: verification?.reason });
    }
  }
  const result = await productionMethod(dependencies, command)({ takeId });
  dependencies.stdout(`Take ${takeId}: ${result?.status ?? command}`);
  return result;
}

/**
 * Side-effect-free CLI dispatcher. Live operations are intentionally provided
 * by an injected productionHost. That host is the explicit composition
 * boundary for Mineflayer actor clients, the privileged production transport,
 * and the rooted artifact host required by artifacts.mjs. Accept is disabled
 * unless a separate recordingHost supplies the native rooted, no-follow
 * openBeneath capability required by capture.mjs; pathname realpath/open
 * approximations are never created here.
 */
export async function runCliCommand(argv, suppliedDependencies = {}) {
  const dependencies = {
    stdout: console.log,
    readText: readFile,
    ...suppliedDependencies
  };
  const [command, ...args] = argv;
  if (command === '--help' || command === 'help') {
    printHelp(dependencies.stdout);
    return;
  }
  if (!COMMANDS.has(command)) throw coded('UNKNOWN_CLI_COMMAND', `Unknown command: ${command}`);
  if (args.includes('--help')) {
    printHelp(dependencies.stdout);
    return;
  }
  if (command === 'security-check') return runSecurityCheck(args, dependencies);
  if (command === 'validate') return runValidate(args, dependencies);
  if (command === 'rehearse') return runRehearse(args, dependencies);
  if (command === 'run') return runTake(args, dependencies);
  if (command === 'recording-ready' || command === 'recording-stopped') {
    return runRecordingAcknowledgement(command, args, dependencies);
  }
  return runDecision(command, args, dependencies);
}

function failurePrefix(command) {
  if (command === 'validate') return 'SHOWRUNNER_VALIDATION_FAILED';
  if (command === 'security-check') return 'SHOWRUNNER_SECURITY_CHECK_FAILED';
  return 'SHOWRUNNER_COMMAND_FAILED';
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await runCliCommand(argv);
  } catch (error) {
    console.error(`${failurePrefix(argv[0])} ${error.code ?? 'ERROR'}: ${error.message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
