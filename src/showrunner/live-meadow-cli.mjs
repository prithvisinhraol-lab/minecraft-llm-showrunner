import { createProductionLiveMeadowHost } from './live-meadow-production.mjs';

let host;

async function shutdown(signal) {
  console.log(`[meadow-live] shutting down (${signal})`);
  host?.close();
}

try {
  host = await createProductionLiveMeadowHost();
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  await host.connect();
  if (host.status().state === 'armed') {
    console.log('[meadow-live] ARMED: VPNAJ may say begin in Minecraft. Say stop to abort.');
  } else {
    console.log('[meadow-live] WAITING: join as VPNAJ, then say begin to preflight and start.');
  }
} catch (error) {
  console.error(`[meadow-live] FAILED: ${error?.code ?? error?.message ?? error}`);
  host?.close();
  process.exitCode = 1;
}
