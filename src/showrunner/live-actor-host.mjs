function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function createLiveActorHost({ actorNames, botFactory, runtimeFactory, onFailure = () => {}, connection = {} }) {
  const entries = Object.entries(actorNames ?? {});
  if (entries.length !== 2 || new Set(entries.map(([, name]) => name)).size !== 2 ||
      entries.some(([id, name]) => !['hero', 'rival'].includes(id) || typeof name !== 'string' || !name)) {
    throw coded('LIVE_ACTOR_NAMES_INVALID');
  }
  if (typeof botFactory !== 'function' || typeof runtimeFactory !== 'function') throw coded('LIVE_ACTOR_FACTORY_REQUIRED');
  const bots = {};
  const runtimes = {};
  let ready = false;
  let closed = false;
  let connecting = null;

  function connect() {
    if (connecting) return connecting;
    const waits = entries.map(([actorId, username]) => new Promise((resolve, reject) => {
      const bot = botFactory({ ...connection, username });
      bots[actorId] = bot;
      const fail = (reason, code = 'LIVE_ACTOR_DISCONNECTED') => {
        if (closed) return;
        const error = coded(code, `${username}: ${reason ?? 'disconnected'}`);
        if (!ready) reject(error);
        onFailure(error);
      };
      bot.once?.('error', (error) => fail(error?.message));
      bot.once?.('kicked', (reason) => fail(reason));
      bot.on?.('end', fail);
      bot.on?.('death', () => {
        if (!ready) {
          bot.respawn?.();
          return;
        }
        fail('died', 'LIVE_ACTOR_DIED');
      });
      bot.once?.('spawn', () => {
        try {
          if (bot.username !== username) throw coded('LIVE_ACTOR_IDENTITY_MISMATCH');
          runtimes[actorId] = runtimeFactory(bot, actorId);
          resolve();
        } catch (error) { reject(error); }
      });
    }));
    connecting = Promise.all(waits).then(() => { ready = true; });
    return connecting;
  }

  function onlinePlayers() {
    const names = new Set();
    for (const bot of Object.values(bots)) for (const name of Object.keys(bot.players ?? {})) names.add(name);
    return [...names].filter((name) => !Object.values(actorNames).includes(name)).sort();
  }

  function close() {
    if (closed) return;
    closed = true;
    ready = false;
    for (const runtime of Object.values(runtimes)) runtime.close?.();
    for (const bot of Object.values(bots)) bot.quit?.('live-meadow-host-close');
  }

  return Object.freeze({
    connect,
    get actors() { return Object.freeze({ ...runtimes }); },
    get bots() { return Object.freeze({ ...bots }); },
    onlinePlayers,
    status: () => Object.freeze({ ready, closed, actorIds: Object.keys(runtimes).sort() }),
    close
  });
}
