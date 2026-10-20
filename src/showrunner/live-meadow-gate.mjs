function snapshot(state, reason = null) {
  return Object.freeze({ state, reason });
}

export function createLiveMeadowGate({ operatorName, isOnline, onBegin, onStop = async () => {} }) {
  if (typeof operatorName !== 'string' || !operatorName || typeof isOnline !== 'function' || typeof onBegin !== 'function') {
    throw new TypeError('A live meadow operator gate requires an operator, presence check, and begin callback');
  }
  let state = 'idle';
  let reason = null;
  let queue = Promise.resolve();
  let closed = false;

  function handleChat(username, message) {
    const command = typeof message === 'string' ? message.trim().toLowerCase() : '';
    if (closed || username !== operatorName || !isOnline(operatorName)) return Promise.resolve(false);
    if (command === 'begin') {
      if (state !== 'idle') return Promise.resolve(false);
      state = 'running';
    }
    const operation = queue.then(async () => {
      if (command === 'begin') {
        try {
          await onBegin();
          state = 'completed';
          return true;
        } catch (error) {
          state = 'aborted';
          reason = error?.code ?? error?.message ?? 'LIVE_MEADOW_FAILED';
          throw error;
        }
      }
      if (command === 'stop') {
        if (!['idle', 'running'].includes(state)) return false;
        state = 'stopping';
        await onStop();
        state = 'aborted';
        reason = 'OPERATOR_STOP';
        return true;
      }
      return false;
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return Object.freeze({
    handleChat,
    status: () => snapshot(state, reason),
    close() { closed = true; }
  });
}
