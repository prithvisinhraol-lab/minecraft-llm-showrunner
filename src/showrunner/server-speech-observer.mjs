function coded(code) {
  return Object.assign(new Error(code), { code });
}

export function subscribePlayerChat(bot, listener) {
  const chat = (username, message) => listener(username, message);
  const messageString = (formatted) => {
    const match = /^<([^>]+)> (.*)$/u.exec(`${formatted}`);
    if (match) listener(match[1], match[2]);
  };
  bot.on?.('chat', chat);
  bot.on?.('messagestr', messageString);
  return () => {
    bot.off?.('chat', chat);
    bot.off?.('messagestr', messageString);
  };
}

function dialogueHoldMs(text) {
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  return Math.min(3_500, 900 + words * 180);
}

export function createServerSpeechObserver({
  bots, actorNames, timeoutMs = 5_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  const recent = [];
  const waiters = new Set();
  let closed = false;
  const listeners = [];

  function record(username, message) {
    const at = Date.now();
    const duplicate = recent.some((entry) => entry.username === username && entry.message === message && at - entry.at < 100);
    if (!duplicate) recent.push({ username, message, at });
    while (recent.length > 40 || recent[0]?.at < at - timeoutMs) recent.shift();
    for (const waiter of waiters) {
      if (waiter.username === username && waiter.text === message) waiter.resolve();
    }
  }

  for (const bot of bots) listeners.push(subscribePlayerChat(bot, record));

  return Object.freeze({
    async observe({ actorId, command, text }) {
      if (closed) throw coded('SPEECH_OBSERVER_CLOSED');
      const username = actorNames[actorId];
      if (!username) throw coded('SPEECH_ACTOR_UNKNOWN');
      if (!recent.some((entry) => entry.username === username && entry.message === text && Date.now() - entry.at <= timeoutMs)) {
        await new Promise((resolve, reject) => {
          let waiter;
          const timer = setTimeout(() => {
            waiters.delete(waiter);
            reject(coded('SPEECH_NOT_SERVER_OBSERVED'));
          }, timeoutMs);
          timer.unref?.();
          waiter = {
            username, text,
            resolve() { clearTimeout(timer); waiters.delete(waiter); resolve(); }
          };
          waiters.add(waiter);
        });
      }
      await sleep(dialogueHoldMs(text));
      return Object.freeze({ authoritative: true, observed: true, speaker: actorId, cueId: command.cueId, text });
    },
    close() {
      closed = true;
      for (const unsubscribe of listeners) unsubscribe();
      for (const waiter of waiters) waiter.resolve();
      waiters.clear();
    }
  });
}
