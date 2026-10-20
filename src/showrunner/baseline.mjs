function coded(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function validateContext(ctx) {
  if (ctx === null || typeof ctx !== 'object') throw coded('RESET_CONTEXT_INVALID');
  if (typeof ctx.attempt?.id !== 'string' || typeof ctx.attempt?.revoke !== 'function' || typeof ctx.attempt?.next !== 'function') {
    throw coded('ATTEMPT_INVALID');
  }
  if (!Array.isArray(ctx.actors) || ctx.actors.length === 0 || ctx.actors.some((actor) =>
    typeof actor?.cancel !== 'function' || typeof actor?.awaitQuiescence !== 'function')) throw coded('ACTORS_INVALID');
  if (ctx.manifest === null || typeof ctx.manifest !== 'object') throw coded('BASELINE_MANIFEST_INVALID');
  if (ctx.manifest.actorBaselines === null || typeof ctx.manifest.actorBaselines !== 'object' || Array.isArray(ctx.manifest.actorBaselines)) {
    throw coded('BASELINE_MANIFEST_INVALID');
  }
  const expectedActors = Object.keys(ctx.manifest.actorBaselines).sort();
  const runtimeActors = ctx.actors.map((actor) => actor.name);
  const validActorSet = expectedActors.length === 2 && ctx.actors.length === 2 &&
    runtimeActors.every((name) => typeof name === 'string' && name.length > 0) &&
    new Set(runtimeActors).size === 2 && new Set(ctx.actors).size === 2 &&
    JSON.stringify([...runtimeActors].sort()) === JSON.stringify(expectedActors);
  if (!validActorSet) throw coded('RESET_ACTOR_MISMATCH');
  if (!Number.isInteger(ctx.manifest.resetTimeoutMs) || ctx.manifest.resetTimeoutMs < 1 || ctx.manifest.resetTimeoutMs > 60_000) {
    throw coded('INVALID_RESET_TIMEOUT');
  }
  if (typeof ctx.manifest.entityCleanupTag !== 'string') throw coded('BASELINE_MANIFEST_INVALID');
  if (typeof ctx.controller?.restore !== 'function' || typeof ctx.controller?.removeTaggedEntities !== 'function' || typeof ctx.controller?.verify !== 'function') {
    throw coded('CONTROLLER_INVALID');
  }
  if (typeof ctx.clock?.setTimeout !== 'function' || typeof ctx.clock?.clearTimeout !== 'function') throw coded('CLOCK_INVALID');
}

function withTimeout(work, timeoutMs, clock, code) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = clock.setTimeout(() => reject(coded(code, { timeoutMs })), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clock.clearTimeout(timer));
}

/**
 * Runs the reset as a strict transaction. The next attempt epoch is created
 * only after cancellation, quiescence, restoration, cleanup, and declared
 * manifest verification have all succeeded.
 */
export async function resetToBaseline(ctx) {
  validateContext(ctx);
  ctx.attempt.revoke('retry');
  const timeoutMs = ctx.manifest.resetTimeoutMs;
  await withTimeout(
    Promise.all(ctx.actors.map((actor) => actor.cancel(ctx.attempt.id))),
    timeoutMs,
    ctx.clock,
    'RESET_CANCELLATION_TIMEOUT'
  );
  await withTimeout(
    Promise.all(ctx.actors.map(async (actor) => {
      const receipt = await actor.awaitQuiescence();
      if (receipt?.acknowledged !== true || receipt?.quiescent !== true) throw coded('QUIESCENCE_NOT_ACKNOWLEDGED');
      return receipt;
    })),
    timeoutMs,
    ctx.clock,
    'QUIESCENCE_TIMEOUT'
  );
  await withTimeout(Promise.resolve(ctx.controller.restore(ctx.manifest)), timeoutMs, ctx.clock, 'RESET_RESTORE_TIMEOUT');
  await withTimeout(Promise.resolve(ctx.controller.removeTaggedEntities(ctx.manifest.entityCleanupTag)), timeoutMs, ctx.clock, 'RESET_CLEANUP_TIMEOUT');
  const verification = await withTimeout(Promise.resolve(ctx.controller.verify(ctx.manifest)), timeoutMs, ctx.clock, 'RESET_VERIFICATION_TIMEOUT');
  if (verification?.ok !== true) throw coded('BASELINE_VERIFICATION_FAILED', { verification });
  const nextAttempt = ctx.attempt.next();
  if (nextAttempt?.id === ctx.attempt.id) throw coded('RESET_EPOCH_REUSED');
  return Object.freeze({ verified: true, verification, nextAttempt });
}
