import catalog from './word-cloud-v1.json';
import type { SessionView } from '../shared/types';
export type Cue = { word: string; category: string; group: string };
export const cues: readonly Cue[] = catalog.entries;
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
/** Only actual presentations consume the bag. Blocked entries wait, never repeat. */
export class WordCloudDeck {
  private remaining: Cue[] = [];
  constructor(private random: () => number = Math.random) {}
  draw(visible: readonly Cue[], fits: (cue: Cue) => boolean = () => true): Cue | null {
    if (!this.remaining.length) this.remaining = shuffle(cues, this.random);
    const groups = new Set(visible.map(cue => cue.group));
    const scene = visible.filter(cue => cue.category === 'scene').length;
    const wantScene = scene * 2 <= visible.length;
    // Drain fuller groups first so the cycle does not end with a long queue
    // from one domain. Shuffled order breaks equal-count/equal-category ties.
    const counts = new Map<string, number>();
    for (const cue of this.remaining) counts.set(cue.group, (counts.get(cue.group) ?? 0) + 1);
    let index = -1, best = -1;
    this.remaining.forEach((cue, i) => {
      if (groups.has(cue.group) || !fits(cue)) return;
      const priority = counts.get(cue.group)! * 2 + Number((cue.category === 'scene') === wantScene);
      if (priority > best) { best = priority; index = i; }
    });
    if (index < 0) return null;
    return this.remaining.splice(index, 1)[0];
  }
}
export function cloudSession(view: Pick<SessionView, 'session' | 'messages' | 'opener'>) {
  return { supported: !!view.opener, ended: view.session.state === 'ended',
    submitted: view.session.state === 'active' || view.messages.some(message => message.role === 'user' && message.origin === 'learner') };
}
