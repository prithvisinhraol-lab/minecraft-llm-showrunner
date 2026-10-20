import path from 'node:path';

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function frozen(value) {
  return Object.freeze(value);
}

function validTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

function validTakeId(value) {
  return typeof value === 'string' && value.length > 0;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function configuredRoot() {
  const root = process.env.SHOWRUNNER_RECORDING_DIR;
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) throw coded('RECORDING_ROOT_INVALID');
  return path.resolve(root);
}

function configuredPath(root, value) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) throw coded('RECORDING_PATH_INVALID');
  const resolved = path.resolve(value);
  if (!inside(root, resolved)) throw coded('RECORDING_PATH_OUTSIDE_ROOT');
  return resolved;
}

function inputValue(input, field) {
  if (input === null || typeof input !== 'object') throw coded('HANDSHAKE_INVALID');
  const descriptor = Object.getOwnPropertyDescriptor(input, field);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw coded('HANDSHAKE_INVALID');
  return descriptor.value;
}

function handshake(input) {
  const takeId = inputValue(input, 'takeId');
  const monotonicTimestamp = inputValue(input, 'monotonicTimestamp');
  if (!validTakeId(takeId) || !validTimestamp(monotonicTimestamp)) throw coded('HANDSHAKE_INVALID');
  return { takeId, monotonicTimestamp };
}

function clockNow(clock) {
  const timestamp = clock?.now?.();
  if (!validTimestamp(timestamp)) throw coded('CLOCK_INVALID');
  return timestamp;
}

function sameIdentity(identity, stat) {
  return Number.isSafeInteger(identity?.dev)
    && Number.isSafeInteger(identity?.ino)
    && Number.isSafeInteger(stat?.dev)
    && Number.isSafeInteger(stat?.ino)
    && identity.dev === stat.dev
    && identity.ino === stat.ino;
}

function validFile(stat) {
  return stat && typeof stat.isFile === 'function' && stat.isFile();
}

function symbolicLink(stat) {
  return stat && typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink();
}

function verifierPort(fsPort) {
  if (!fsPort || typeof fsPort.openBeneath !== 'function') {
    throw coded('ROOTED_OPEN_REQUIRED');
  }
  return fsPort;
}

function failed(reason) {
  return frozen({ ok: false, reason });
}

function snapshotAcknowledgement(kind, event) {
  return frozen({ acknowledged: true, kind, ...event });
}

async function closeQuietly(handle) {
  try {
    await handle?.close?.();
  } catch {}
}

/**
 * Required fsPort boundary for a real recording-host adapter:
 *
 * openBeneath({ rootPath, relativePath, flags }) must atomically traverse from
 * a trusted descriptor for rootPath, reject every symlink traversal, and open
 * relativePath read-only. It returns { handle, canonicalRootPath, canonicalPath,
 * identity }, where both canonical paths and identity are derived from that same
 * descriptor walk/open. handle.stat() must describe the already-opened file and
 * match identity by dev/ino. A pathname realpath/lstat/open sequence is not an
 * acceptable substitute because an ancestor can be replaced between those calls.
 */
async function openVerified(fsPort, rootPath, relativePath, label) {
  let opened;
  try {
    opened = await fsPort.openBeneath({
      rootPath,
      relativePath,
      flags: frozen({ readOnly: true, noFollow: true })
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return { reason: `${label}_MISSING` };
    if (error?.code === 'ELOOP') return { reason: `${label}_SYMLINK` };
    return { reason: `${label}_ROOTED_OPEN_FAILED` };
  }

  const handle = opened?.handle;
  const canonicalRootPath = opened?.canonicalRootPath;
  const canonicalPath = opened?.canonicalPath;
  if (!handle || typeof handle.stat !== 'function' || typeof handle.close !== 'function'
    || typeof canonicalRootPath !== 'string' || !path.isAbsolute(canonicalRootPath)
    || typeof canonicalPath !== 'string' || !path.isAbsolute(canonicalPath)
    || !Number.isSafeInteger(opened?.rootIdentity?.dev) || !Number.isSafeInteger(opened?.rootIdentity?.ino)) {
    await closeQuietly(handle);
    return { reason: `${label}_ROOTED_OPEN_UNPROVEN` };
  }
  const resolvedRoot = path.resolve(canonicalRootPath);
  const resolvedPath = path.resolve(canonicalPath);
  const expectedRoot = path.resolve(rootPath);
  const expectedPath = path.resolve(expectedRoot, relativePath);
  if (resolvedRoot !== expectedRoot) {
    await closeQuietly(handle);
    return { reason: `${label}_ROOT_MISMATCH` };
  }
  if (resolvedPath !== expectedPath) {
    await closeQuietly(handle);
    return { reason: `${label}_PATH_MISMATCH` };
  }
  if (!inside(resolvedRoot, resolvedPath)) {
    await closeQuietly(handle);
    return { reason: `${label}_PATH_OUTSIDE_ROOT` };
  }

  let stat;
  try {
    stat = await handle.stat();
  } catch {
    await closeQuietly(handle);
    return { reason: `${label}_ROOTED_OPEN_UNPROVEN` };
  }
  if (!sameIdentity(opened.identity, stat) || symbolicLink(stat) || !validFile(stat)) {
    await closeQuietly(handle);
    return { reason: `${label}_ROOTED_OPEN_UNPROVEN` };
  }
  return { handle, stat, resolvedPath, rootIdentity: opened.rootIdentity };
}

function validSidecar(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.takeId === expected.takeId
    && value.path === expected.path
    && value.readyMonotonicTimestamp === expected.readyMonotonicTimestamp
    && value.startMonotonicTimestamp === expected.startMonotonicTimestamp
    && value.stopMonotonicTimestamp === expected.stopMonotonicTimestamp;
}

/**
 * Tracks a manually-operated OBS recording handshake. `expectedPath` is checked
 * lexically at construction because a future output need not exist yet. Artifact
 * proof is deferred until verifyArtifact: fsPort.openBeneath must atomically
 * traverse from a trusted recording-root descriptor with no symlink following and
 * return descriptor-derived canonical paths and the opened file identity.
 */
export function createCaptureSession({ takeId, expectedPath, clock, preRollMs }) {
  if (!validTakeId(takeId)) throw coded('TAKE_ID_INVALID');
  if (!Number.isFinite(preRollMs) || preRollMs < 0) throw coded('PRE_ROLL_INVALID');

  const recordingRoot = configuredRoot();
  const recordingPath = configuredPath(recordingRoot, expectedPath);
  const session = frozen({ takeId, recordingPath, preRollMs });
  let ready;
  let started;
  let stopRequested;
  let stopped;

  return frozen({
    acknowledgeReady(input) {
      if (ready) throw coded('READY_ALREADY_ACKNOWLEDGED');
      const acknowledged = handshake(input);
      const readyPath = configuredPath(recordingRoot, inputValue(input, 'path'));
      if (acknowledged.takeId !== session.takeId) throw coded('WRONG_TAKE');
      if (readyPath !== session.recordingPath) throw coded('WRONG_RECORDING_PATH');
      ready = frozen({ ...acknowledged, path: session.recordingPath });
      return snapshotAcknowledgement('ready', ready);
    },

    markTakeStarted() {
      if (!ready) throw coded('READY_NOT_ACKNOWLEDGED');
      if (started) throw coded('TAKE_ALREADY_STARTED');
      const monotonicTimestamp = clockNow(clock);
      if (monotonicTimestamp < ready.monotonicTimestamp + session.preRollMs) throw coded('PRE_ROLL_INCOMPLETE');
      started = frozen({ monotonicTimestamp });
      return snapshotAcknowledgement('started', started);
    },

    requestStop() {
      if (!started) throw coded('TAKE_NOT_STARTED');
      if (stopRequested) throw coded('STOP_ALREADY_REQUESTED');
      const monotonicTimestamp = clockNow(clock);
      if (monotonicTimestamp < started.monotonicTimestamp) throw coded('NON_MONOTONIC_STOP');
      stopRequested = frozen({ monotonicTimestamp });
      return snapshotAcknowledgement('stop-requested', stopRequested);
    },

    acknowledgeStopped(input) {
      if (!stopRequested) throw coded('STOP_NOT_REQUESTED');
      if (stopped) throw coded('STOP_ALREADY_ACKNOWLEDGED');
      const acknowledged = handshake(input);
      const stoppedPath = configuredPath(recordingRoot, inputValue(input, 'path'));
      if (acknowledged.takeId !== session.takeId) throw coded('WRONG_TAKE');
      if (stoppedPath !== session.recordingPath) throw coded('WRONG_RECORDING_PATH');
      if (acknowledged.monotonicTimestamp < stopRequested.monotonicTimestamp) throw coded('NON_MONOTONIC_STOP');
      stopped = frozen({ ...acknowledged, path: stoppedPath });
      return snapshotAcknowledgement('stopped', stopped);
    },

    async verifyArtifact(fsPort) {
      if (!ready) return failed('READY_NOT_ACKNOWLEDGED');
      if (!started) return failed('TAKE_NOT_STARTED');
      if (!stopRequested || !stopped) return failed('STOP_NOT_ACKNOWLEDGED');

      try {
        verifierPort(fsPort);
      } catch (error) {
        return failed(error.code ?? 'FS_PORT_INVALID');
      }

      const artifact = await openVerified(
        fsPort,
        recordingRoot,
        path.relative(recordingRoot, session.recordingPath),
        'ARTIFACT'
      );
      if (artifact.reason) return failed(artifact.reason);
      try {
        if (!Number.isFinite(artifact.stat.size) || artifact.stat.size <= 0) return failed('ARTIFACT_EMPTY');
        if (!validTimestamp(artifact.stat.startMonotonicTimestamp) || !validTimestamp(artifact.stat.endMonotonicTimestamp)) {
          return failed('ARTIFACT_COVERAGE_UNAVAILABLE');
        }
        if (artifact.stat.startMonotonicTimestamp > ready.monotonicTimestamp) return failed('ARTIFACT_START_AFTER_READY');
        if (artifact.stat.endMonotonicTimestamp < stopped.monotonicTimestamp) return failed('ARTIFACT_END_BEFORE_STOP');

        const sidecarPath = `${session.recordingPath}.showrunner.json`;
        const sidecar = await openVerified(
          fsPort,
          recordingRoot,
          path.relative(recordingRoot, sidecarPath),
          'SIDECAR'
        );
        if (sidecar.reason) return failed(sidecar.reason);
        try {
          if (!sameIdentity(artifact.rootIdentity, sidecar.rootIdentity)) return failed('SIDECAR_ROOT_IDENTITY_MISMATCH');
          const contents = await sidecar.handle.readFile({ encoding: 'utf8' });
          let parsed;
          try {
            parsed = JSON.parse(String(contents));
          } catch {
            return failed('SIDECAR_INVALID');
          }
          if (!validSidecar(parsed, {
            takeId: session.takeId,
            path: artifact.resolvedPath,
            readyMonotonicTimestamp: ready.monotonicTimestamp,
            startMonotonicTimestamp: started.monotonicTimestamp,
            stopMonotonicTimestamp: stopped.monotonicTimestamp
          })) return failed('SIDECAR_MISMATCH');
        } finally {
          await sidecar.handle.close();
        }
      } finally {
        await artifact.handle.close();
      }

      return frozen({ ok: true, path: session.recordingPath });
    }
  });
}
