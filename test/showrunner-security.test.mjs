import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyOperatorMigration, planOperatorMigration } from '../src/showrunner/security.mjs';

function op(name, level = 4) {
  return { uuid: `${name}-uuid`, name, level, bypassesPlayerLimit: false };
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

test('removes actor ops but preserves the named production controller', () => {
  const entries = [op('HeroActor'), op('RivalActor'), op('ProductionController'), op('HumanOwner')];
  const result = planOperatorMigration(entries, {
    actorNames: ['HeroActor', 'RivalActor'],
    controllerName: 'ProductionController'
  });

  assert.deepEqual(result.removedActors, ['HeroActor', 'RivalActor']);
  assert.equal(result.controller.name, 'ProductionController');
  assert.deepEqual(result.nextEntries.map((entry) => entry.name), ['ProductionController', 'HumanOwner']);
});

test('matches actor and controller names case-insensitively', () => {
  const result = planOperatorMigration([op('heroactor'), op('productioncontroller'), op('HumanOwner')], {
    actorNames: ['HeroActor'],
    controllerName: 'ProductionController'
  });

  assert.deepEqual(result.removedActors, ['heroactor']);
  assert.equal(result.controller.name, 'productioncontroller');
  assert.deepEqual(result.nextEntries.map((entry) => entry.name), ['productioncontroller', 'HumanOwner']);
});

test('refuses migration when controller is absent or also listed as an actor', () => {
  assert.throws(() => planOperatorMigration([op('HumanOwner')], {
    actorNames: ['HeroActor'],
    controllerName: 'ProductionController'
  }), { code: 'CONTROLLER_NOT_OP' });

  assert.throws(() => planOperatorMigration([op('ProductionController')], {
    actorNames: ['ProductionController'],
    controllerName: 'ProductionController'
  }), { code: 'CONTROLLER_IS_ACTOR' });
});

test('atomically replaces actor ops and preserves an exclusive backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-security-'));
  const opsPath = path.join(directory, 'ops.json');
  const entries = [op('HeroActor'), op('RivalActor'), op('ProductionController'), op('HumanOwner')];
  await writeFile(opsPath, JSON.stringify(entries, null, 2));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const { backupPath, result } = await applyOperatorMigration(opsPath, {
    actorNames: ['HeroActor', 'RivalActor'],
    controllerName: 'ProductionController'
  });

  assert.equal(backupPath, `${opsPath}.pre-showrunner-backup`);
  assert.deepEqual(result.removedActors, ['HeroActor', 'RivalActor']);
  assert.deepEqual(JSON.parse(await readFile(backupPath, 'utf8')), entries);
  assert.deepEqual(
    JSON.parse(await readFile(opsPath, 'utf8')).map((entry) => entry.name),
    ['ProductionController', 'HumanOwner']
  );
});

test('refuses to overwrite an existing migration backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-security-'));
  const opsPath = path.join(directory, 'ops.json');
  const entries = [op('HeroActor'), op('ProductionController')];
  await writeFile(opsPath, JSON.stringify(entries));
  await writeFile(`${opsPath}.pre-showrunner-backup`, 'do not overwrite');
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    applyOperatorMigration(opsPath, {
      actorNames: ['HeroActor'],
      controllerName: 'ProductionController'
    }),
    { code: 'BACKUP_EXISTS' }
  );
  assert.deepEqual(JSON.parse(await readFile(opsPath, 'utf8')), entries);
});

test('refuses an under-privileged controller before creating a backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-security-'));
  const opsPath = path.join(directory, 'ops.json');
  const entries = [op('HeroActor'), op('ProductionController', 3)];
  await writeFile(opsPath, JSON.stringify(entries));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    applyOperatorMigration(opsPath, {
      actorNames: ['HeroActor'],
      controllerName: 'ProductionController'
    }),
    { code: 'CONTROLLER_NOT_LEVEL_4' }
  );
  assert.deepEqual(JSON.parse(await readFile(opsPath, 'utf8')), entries);
  await assert.rejects(readFile(`${opsPath}.pre-showrunner-backup`, 'utf8'), { code: 'ENOENT' });
});

test('requires exclusive migration ownership before reading or replacing ops JSON', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-security-'));
  const opsPath = path.join(directory, 'ops.json');
  const entries = [op('HeroActor'), op('ProductionController')];
  await writeFile(opsPath, JSON.stringify(entries));
  await writeFile(`${opsPath}.showrunner.lock`, 'another migration owns this file');
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(applyOperatorMigration(opsPath, {
    actorNames: ['HeroActor'],
    controllerName: 'ProductionController'
  }), { code: 'MIGRATION_LOCKED' });
  assert.deepEqual(JSON.parse(await readFile(opsPath, 'utf8')), entries);
  await assert.rejects(readFile(`${opsPath}.pre-showrunner-backup`, 'utf8'), { code: 'ENOENT' });
});

test('dry-run reports planned actor removals without changing ops JSON', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-security-'));
  const opsPath = path.join(directory, 'ops.json');
  const entries = [op('HeroActor'), op('RivalActor'), op('ProductionController'), op('HumanOwner')];
  await writeFile(opsPath, JSON.stringify(entries));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const run = await runCli(
    'security-check', '--actors', 'HeroActor,RivalActor', '--controller', 'ProductionController',
    '--ops-path', opsPath, '--dry-run'
  );

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /HeroActor/);
  assert.match(run.stdout, /RivalActor/);
  assert.match(run.stdout, /ProductionController/);
  assert.deepEqual(JSON.parse(await readFile(opsPath, 'utf8')), entries);
  await assert.rejects(readFile(`${opsPath}.pre-showrunner-backup`, 'utf8'), { code: 'ENOENT' });
});

test('security check fails closed when the named controller is not an operator', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-security-'));
  const opsPath = path.join(directory, 'ops.json');
  const entries = [op('HeroActor'), op('HumanOwner')];
  await writeFile(opsPath, JSON.stringify(entries));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const run = await runCli(
    'security-check', '--actors', 'HeroActor,RivalActor', '--controller', 'ProductionController',
    '--ops-path', opsPath, '--dry-run'
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /CONTROLLER_NOT_OP/);
  assert.deepEqual(JSON.parse(await readFile(opsPath, 'utf8')), entries);
});

test('security check rejects a missing option value instead of treating a flag as an actor', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-security-'));
  const opsPath = path.join(directory, 'ops.json');
  const entries = [op('HeroActor'), op('ProductionController')];
  await writeFile(opsPath, JSON.stringify(entries));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const run = await runCli(
    'security-check', '--actors', '--controller', 'ProductionController', '--ops-path', opsPath, '--dry-run'
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /MISSING_OPTION_VALUE/);
  assert.deepEqual(JSON.parse(await readFile(opsPath, 'utf8')), entries);
});

test('security check requires explicit apply permission before mutating ops JSON', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'showrunner-security-'));
  const opsPath = path.join(directory, 'ops.json');
  const entries = [op('HeroActor'), op('ProductionController')];
  await writeFile(opsPath, JSON.stringify(entries));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const run = await runCli(
    'security-check', '--actors', 'HeroActor', '--controller', 'ProductionController', '--ops-path', opsPath
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /APPLY_LIVE_REQUIRED/);
  assert.deepEqual(JSON.parse(await readFile(opsPath, 'utf8')), entries);
  await assert.rejects(readFile(`${opsPath}.pre-showrunner-backup`, 'utf8'), { code: 'ENOENT' });
});

test('CLI help documents the explicit apply permission', async () => {
  const run = await runCli('--help');

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /--apply-live/);
});
