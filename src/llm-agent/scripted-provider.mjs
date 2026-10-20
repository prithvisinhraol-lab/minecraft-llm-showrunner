function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createScriptedProvider(decisions) {
  if (!Array.isArray(decisions)) throw new TypeError('decisions must be an array');
  const remaining = structuredClone(decisions);

  return {
    async decide(_context, { signal } = {}) {
      if (signal?.aborted) throw coded('LLM_AGENT_PROVIDER_ABORTED', 'scripted decision was aborted');
      if (remaining.length === 0) throw coded('LLM_AGENT_SCRIPT_EXHAUSTED', 'scripted decisions are exhausted');
      return structuredClone(remaining.shift());
    }
  };
}
