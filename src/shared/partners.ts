import type { Character } from './types';
export const partnerOrder = ['model_01', 'model_03', 'model_02', 'model_04', 'model_07', 'model_08', 'model_05', 'model_09'] as const;
const names: Record<string, string> = {
  'anthropic/claude-fable-5.1': 'Fable 5.1', 'anthropic/claude-sonnet-5': 'Sonnet 5',
  'xiaomi/mimo-v2.5-pro': 'MiMo V2.5 Pro', 'openai/gpt-6-astra': 'Astra',
  'bytedance-seed/seed-2-1-turbo': 'Seed 2.1 Turbo', 'deepseek/deepseek-v4-pro-0813': 'DeepSeek V4 Pro 0813',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash', 'deepseek/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash'
};
export const modelDisplayName = (model: string) => names[model] ?? model;
export function orderedPartners(saved: Character[]): Character[] {
  const rank = (id: string) => { const n = partnerOrder.indexOf(id as typeof partnerOrder[number]); return n < 0 ? partnerOrder.length : n; };
  return [...saved].sort((a, b) => rank(a.id) - rank(b.id));
}
export const partnerDisplayName = (partner?: Character) => partner ? `${partner.label} · ${modelDisplayName(partner.model)}` : 'Automatic';
