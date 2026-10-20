import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';

import mineflayer from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

import { sourceEpisodeHash } from './approved-bank.mjs';
import { createActorRuntime } from './actor-runtime.mjs';
import { createFixedLineBank } from './fixed-line-bank.mjs';
import { createLiveActorHost } from './live-actor-host.mjs';
import { createLiveMeadowHost } from './live-meadow-host.mjs';
import { createLiveMeadowObserver } from './live-meadow-observer.mjs';
import { runLiveMeadowPreflight } from './live-meadow-preflight.mjs';
import { createLiveTestPorts } from './live-test-ports.mjs';
import { createServerSpeechObserver, subscribePlayerChat } from './server-speech-observer.mjs';
import { loadEpisode } from './schema.mjs';
import { createSurvivalAuthority } from './survival-authority.mjs';
import { loadSurvivalEpisode } from './survival-schema.mjs';

const { pathfinder: pathfinderPlugin, Movements } = pathfinderPackage;

function coded(code) {
  return Object.assign(new Error(code), { code });
}

const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'cactus', 'magma_block', 'sweet_berry_bush']);

function passable(block) {
  return !block || block.boundingBox === 'empty' || ['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern'].includes(block.name);
}

function inspectedPoint(bot, position) {
  const point = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const support = bot.blockAt(new Vec3(point.x, point.y - 1, point.z));
  const feet = bot.blockAt(new Vec3(point.x, point.y, point.z));
  const head = bot.blockAt(new Vec3(point.x, point.y + 1, point.z));
  return {
    dimension: bot.game?.dimension === 'overworld' ? 'minecraft:overworld' : bot.game?.dimension,
    position: point,
    support: support?.name ?? 'air',
    hazardous: HAZARDS.has(support?.name) || HAZARDS.has(feet?.name) || HAZARDS.has(head?.name),
    feetPassable: passable(feet), headPassable: passable(head), reachable: true
  };
}

function blocksInRegion(bot, region) {
  const found = [];
  for (let x = region.min.x; x <= region.max.x; x += 1) for (let y = region.min.y; y <= region.max.y; y += 1) {
    for (let z = region.min.z; z <= region.max.z; z += 1) {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (block && region.allowedBlocks.includes(block.name)) found.push({ x, y, z, block: block.name });
    }
  }
  return found;
}

export function inspectLiveMeadowPreflight({ episode, survivalEpisode, bots, operatorName }) {
  const heroBot = bots.hero;
  const operatorPosition = heroBot.players?.[operatorName]?.entity?.position;
  if (!operatorPosition) throw coded('OPERATOR_OFFLINE');
  const marks = episode.scene.marks;
  const cells = Object.values(survivalEpisode.regions).flatMap((region) => region.allowedCells ?? []);
  const valid = cells.filter((cell) => survivalEpisode.regions.hero_mine_lane.allowedBlocks?.includes?.(
    heroBot.blockAt(new Vec3(cell.x, cell.y, cell.z))?.name
  ) || heroBot.blockAt(new Vec3(cell.x, cell.y, cell.z))?.name === 'stone').length;
  return {
    operatorName,
    onlinePlayers: [...new Set([...Object.keys(heroBot.players ?? {}), 'HeroActor', 'RivalActor'])],
    camera: inspectedPoint(heroBot, operatorPosition),
    hero: inspectedPoint(heroBot, marks.hero_start.position),
    rival: inspectedPoint(bots.rival, marks.rival_start.position),
    crafting: inspectedPoint(heroBot, marks.crafting_table.position),
    treeTargets: {
      hero: blocksInRegion(heroBot, survivalEpisode.regions.hero_tree),
      rival: blocksInRegion(bots.rival, survivalEpisode.regions.rival_tree)
    },
    excavationCells: { expected: cells.length, valid }
  };
}

export { createServerSpeechObserver, subscribePlayerChat } from './server-speech-observer.mjs';

function sameMark(left, right) {
  return left && right && left.dimension === right.dimension &&
    ['x', 'y', 'z'].every((axis) => left.position?.[axis] === right.position?.[axis]) &&
    left.safeHeadroom === true;
}

export async function createProductionLiveMeadowHost({
  host = process.env.MC_HOST || '127.0.0.1',
  port = Number(process.env.MC_PORT || 25565),
  version = process.env.MC_VERSION || '1.21.4',
  auth = process.env.MC_AUTH || 'offline',
  operatorName = 'VPNAJ',
  actorNames = { hero: 'HeroActor', rival: 'RivalActor' },
  episodePath = path.resolve('production/episodes/first-day-meadow.yaml'),
  survivalEpisodePath = path.resolve('production/episodes/first-day-meadow.survival.yaml'),
  statusSink = (status) => console.log(`[meadow-live] ${JSON.stringify(status)}`)
} = {}) {
  const episode = await loadEpisode(episodePath);
  const survivalEpisode = await loadSurvivalEpisode(survivalEpisodePath);
  const approvalKeys = generateKeyPairSync('ed25519');
  const authorityKeys = generateKeyPairSync('ed25519');
  const clock = performance;
  const authority = createSurvivalAuthority({ clock, signingKey: authorityKeys.privateKey });
  const approvedBank = createFixedLineBank(episode, approvalKeys.privateKey);
  let actorHost;
  let liveHost;
  let liveObserver;
  let speechObserver;
  const chatListeners = [];

  const markVerifier = Object.freeze({
    verifyMark(_action, payload) {
      const supplied = payload.mark;
      const allowed = [
        ...Object.values(episode.scene.marks),
        ...Object.values(survivalEpisode.marks).map((mark) => ({
          ...mark, dimension: mark.dimension ?? 'minecraft:overworld',
          facing: mark.facing ?? { yaw: 0, pitch: 0 }, radius: mark.radius ?? 1,
          dwellTicks: mark.dwellTicks ?? 1, safeHeadroom: true
        }))
      ];
      const normalized = typeof supplied === 'string' ? survivalEpisode.marks[supplied] : supplied;
      const candidate = normalized && {
        ...normalized,
        dimension: normalized.dimension ?? 'minecraft:overworld',
        facing: normalized.facing ?? { yaw: 0, pitch: 0 },
        radius: normalized.radius ?? 1,
        dwellTicks: normalized.dwellTicks ?? 1,
        safeHeadroom: true
      };
      if (!allowed.some((mark) => sameMark(candidate, mark))) throw coded('LIVE_MARK_NOT_AUTHORED');
      return candidate;
    }
  });

  const delegatedSpeechObserver = Object.freeze({
    observe(input) {
      if (!speechObserver) throw coded('SPEECH_OBSERVER_NOT_READY');
      return speechObserver.observe(input);
    }
  });
  const delegatedSurvivalObserver = Object.freeze({
    observe(input) {
      if (!liveObserver) throw coded('SURVIVAL_OBSERVER_NOT_READY');
      return liveObserver.observe(input);
    }
  });

  actorHost = createLiveActorHost({
    actorNames,
    connection: { host, port, version, auth },
    botFactory(config) {
      const bot = mineflayer.createBot(config);
      bot.loadPlugin(pathfinderPlugin);
      return bot;
    },
    runtimeFactory(bot, actorId) {
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
      return createActorRuntime({
        bot, actorId, movements, clock, verifier: markVerifier,
        approvalPublicKey: approvalKeys.publicKey,
        episodeContentHash: sourceEpisodeHash(episode),
        speechObserver: delegatedSpeechObserver,
        survivalAuthority: authority,
        survivalObserver: delegatedSurvivalObserver,
        operationTimeoutMs: 60_000
      });
    },
    onFailure(error) { void liveHost?.abort(error); }
  });

  const ports = createLiveTestPorts({ actorNames: Object.keys(actorNames), clock });
  liveHost = createLiveMeadowHost({
    episode, survivalEpisode, approvedBank, approvalPublicKey: approvalKeys.publicKey,
    authority, actorHost, ports, operatorName, clock, statusSink,
    preflight: async () => {
      liveObserver = createLiveMeadowObserver({ episode: survivalEpisode, bots: actorHost.bots });
      speechObserver = createServerSpeechObserver({ bots: Object.values(actorHost.bots), actorNames });
      const input = inspectLiveMeadowPreflight({ episode, survivalEpisode, bots: actorHost.bots, operatorName });
      return runLiveMeadowPreflight(input);
    }
  });

  const originalConnect = liveHost.connect.bind(liveHost);
  return Object.freeze({
    ...liveHost,
    async connect() {
      const result = await originalConnect();
      for (const bot of Object.values(actorHost.bots)) {
        chatListeners.push(subscribePlayerChat(bot, (username, message) => {
          void liveHost.handleChat(username, message);
        }));
      }
      return result;
    },
    close() {
      for (const unsubscribe of chatListeners) unsubscribe();
      speechObserver?.close();
      liveHost.close();
    }
  });
}
