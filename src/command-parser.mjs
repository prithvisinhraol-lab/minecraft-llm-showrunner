export function parseBotMessages(message) {
  const trimmed = message.trim();
  if (!trimmed.startsWith('bot ')) return [];

  const normalized = trimmed.replace(/([a-z])bot\s+/gi, '$1, bot ');

  return normalized
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const commandText = index === 0 ? part.slice(4).trim() : part.replace(/^bot\s+/, '').trim();
      const [command, ...args] = commandText.split(/\s+/);
      return command ? { command, args } : null;
    })
    .filter(Boolean);
}
