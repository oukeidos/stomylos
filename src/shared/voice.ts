export const voices = ['ara', 'eve', 'leo', 'rex', 'sal'] as const;
export type VoiceId = typeof voices[number];
export const isVoice = (value: unknown): value is VoiceId => voices.includes(value as VoiceId);
export const previewText = "Hi! I'm here to help you practice English. What would you like to talk about today?";
export interface PreviewSource { kind: 'preview'; content: string }
export const previewSource: PreviewSource = { kind: 'preview', content: previewText };
