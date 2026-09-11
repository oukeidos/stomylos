import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadEmbedding, embeddingInput, tokenWindows } from '../src/main/memory-embedding';
import { dot } from '../src/main/memory-vectors';
it('runs the pinned local q8 model with normalized CLS output and complete long-input windows', async () => {
  const engine = await loadEmbedding(resolve('assets/memory-model'));
  try {
    const now = performance.now();
    const a = await engine.embed('The user enjoys hiking in the mountains.');
    const b = await engine.embed('The user likes going on mountain hikes.');
    const c = await engine.embed('The user repairs database queries at work.');
    expect(a.vector).toHaveLength(384); expect(dot(a.vector,a.vector)).toBeCloseTo(1, 5);
    expect(dot(a.vector,b.vector)).toBeGreaterThan(dot(a.vector,c.vector));
    const long = await engine.embed('The user hikes every weekend. '.repeat(160));
    expect(long.chunkCount).toBeGreaterThan(1); expect(dot(long.vector,long.vector)).toBeCloseTo(1,5);
    expect(embeddingInput('cafe\u0301\r\n  here')).toBe('café here');
    const tokens = Array.from({length:1500},(_,i)=>i), windows=tokenWindows(tokens);
    expect(windows.reduce((n,w)=>n+w.newTokens,0)).toBe(1500);
    expect(new Set(windows.flatMap(w=>w.tokens))).toEqual(new Set(tokens));
    console.log(JSON.stringify({shortPairCosine:dot(a.vector,b.vector),unrelatedCosine:dot(a.vector,c.vector),longChunks:long.chunkCount,elapsedMs:performance.now()-now}));
  } finally { await engine.close(); }
}, 90000);
