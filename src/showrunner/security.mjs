import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function planOperatorMigration(entries, { actorNames, controllerName }) {
  const actors = new Set(actorNames.map((name) => name.toLowerCase()));
  if (actors.has(controllerName.toLowerCase())) throw coded('CONTROLLER_IS_ACTOR');

  const controller = entries.find((entry) => entry.name.toLowerCase() === controllerName.toLowerCase());
  if (!controller) throw coded('CONTROLLER_NOT_OP');

  const removedActors = entries
    .filter((entry) => actors.has(entry.name.toLowerCase()))
    .map((entry) => entry.name);

  return {
    controller,
    removedActors,
    nextEntries: entries.filter((entry) => !actors.has(entry.name.toLowerCase()))
  };
}

function assertControllerLevel(controller) {
  if (controller.level !== 4) throw coded('CONTROLLER_NOT_LEVEL_4');
}

function parseOperatorEntries(contents) {
  const entries = JSON.parse(contents);
  if (!Array.isArray(entries)) throw coded('INVALID_OPS_FILE');
  return entries;
}

export async function applyOperatorMigration(opsPath, options) {
  const lockPath = `${opsPath}.showrunner.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx');
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, operation: 'showrunner-operator-migration' })}\n`, 'utf8');
  } catch (error) {
    await lock?.close?.();
    if (error.code === 'EEXIST') throw coded('MIGRATION_LOCKED');
    throw error;
  }

  try {
    const source = await readFile(opsPath, 'utf8');
    const entries = parseOperatorEntries(source);
    const result = planOperatorMigration(entries, options);
    assertControllerLevel(result.controller);

    const backupPath = `${opsPath}.pre-showrunner-backup`;
    try {
      await writeFile(backupPath, source, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw coded('BACKUP_EXISTS');
      throw error;
    }

    const temporaryPath = path.join(
      path.dirname(opsPath),
      `.${path.basename(opsPath)}.${randomUUID()}.tmp`
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(result.nextEntries, null, 2)}\n`, 'utf8');
      if (await readFile(opsPath, 'utf8') !== source) {
        await rm(backupPath, { force: true });
        throw coded('OPS_FILE_CHANGED');
      }
      await rename(temporaryPath, opsPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }

    const verifiedEntries = parseOperatorEntries(await readFile(opsPath, 'utf8'));
    const verified = planOperatorMigration(verifiedEntries, options);
    if (verified.removedActors.length !== 0) throw coded('ACTOR_OP_REMAINS');
    assertControllerLevel(verified.controller);

    return { backupPath, result };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
