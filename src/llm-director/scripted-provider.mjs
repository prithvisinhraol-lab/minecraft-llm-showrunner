export function createScriptedDirectorProvider(decisions = []) {
  const queue = structuredClone(decisions);
  return Object.freeze({
    async select() {
      if (queue.length === 0) {
        const error = new Error('scripted director decisions are exhausted');
        error.code = 'LLM_DIRECTOR_SCRIPT_EXHAUSTED';
        throw error;
      }
      return structuredClone(queue.shift());
    }
  });
}
