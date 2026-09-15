/** Content admission is shared by the composer and transactional Send. UTF-8 bytes. */
export const conversationLimits = Object.freeze({ turns: 512, messageBytes: 6000, learnerBytes: 48000, totalBytes: 160000 });
export const conversationWarning = Object.freeze({ turns: 410, learnerBytes: 38400, totalBytes: 128000 });
export type ConversationLimitReason = 'message_limit' | 'learner_limit' | 'history_limit' | 'turn_limit';
export const conversationLimitText: Record<ConversationLimitReason, string> = {
  message_limit: 'This message exceeds 6,000 bytes. Shorten it before sending; your draft is preserved.',
  learner_limit: 'Your messages have reached this chat’s allowance. End the chat and start a new one; your draft is preserved.',
  history_limit: 'This chat has reached its total size allowance. End it and start a new one; your draft is preserved.',
  turn_limit: 'This chat has reached 512 messages from you. End it and start a new one; your draft is preserved.'
};
export function conversationBudget(messages: { origin: string; content: string }[], next = '') {
  const encoder = new TextEncoder(), size = (text: string) => encoder.encode(text).length;
  const users = messages.filter(m => m.origin === 'learner');
  const learnerBytes = users.reduce((n, m) => n + size(m.content), 0);
  const totalBytes = messages.reduce((n, m) => n + size(m.content), 0);
  const nextBytes = size(next);
  const reason: ConversationLimitReason | null = nextBytes > conversationLimits.messageBytes ? 'message_limit'
    : users.length >= conversationLimits.turns ? 'turn_limit'
    : learnerBytes + nextBytes > conversationLimits.learnerBytes ? 'learner_limit'
    : totalBytes + nextBytes > conversationLimits.totalBytes ? 'history_limit' : null;
  return { allowed: reason === null, reason, near: users.length >= conversationWarning.turns ||
    learnerBytes >= conversationWarning.learnerBytes || totalBytes >= conversationWarning.totalBytes };
}
