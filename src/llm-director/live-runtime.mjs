import { createAgentController } from '../llm-agent/controller.mjs';
import { createDirectorController } from './controller.mjs';

export function createDirectorLiveRuntime({
  actorId, overallObjective, adapter, actorStore, actorProvider, directorStore, directorProvider,
  providerKind = 'codex', agentControllerFactory = createAgentController,
  directorControllerFactory = createDirectorController
} = {}) {
  let activeFastController = null;
  const director = directorControllerFactory({
    actorId, overallObjective, store: directorStore, provider: directorProvider,
    loadAgentState: () => actorStore.load(actorId),
    inspectPrerequisite: (goal, priorState, options) => adapter.inspectPrerequisite(goal, priorState, options),
    async runGoal(goal) {
      const fast = agentControllerFactory({
        actorId, goal, store: actorStore, provider: actorProvider, adapter,
        evidenceSource: 'mineflayer-live', providerKind
      });
      activeFastController = fast;
      try {
        await fast.start();
        await fast.awaitIdle();
        return await fast.status();
      } finally {
        activeFastController = null;
      }
    }
  });

  async function stopFast(reason = 'director stop') { return activeFastController?.stop?.(reason); }
  async function close() {
    await activeFastController?.stop?.('runtime closing');
    await director.stop('runtime closing');
    await director.awaitIdle();
  }
  return Object.freeze({ controller: director, stopFast, close });
}
