import { expect, it, vi } from 'vitest';
import { WordCloudDeck, cues, cloudSession } from '../src/renderer/word-cloud-selection';
import { cloudLayout, cloudPosition, WordCloudFlow } from '../src/renderer/word-cloud-flow';
import type { SessionView } from '../src/shared/types';
function random(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
it('consumes every word once per cycle without repeating visible groups, including blocked tails', () => {
  for (let seed=0;seed<40;seed++) {
    const deck=new WordCloudDeck(random(seed));let visible: typeof cues[number][]=[];
    for(let cycle=0;cycle<3;cycle++) {
      const seen=new Set<string>();let stalled=0;
      while(seen.size<240) {
        if(visible.length>=24) visible.splice(Math.floor(random(seed+seen.size)()*visible.length),1);
        const cue=deck.draw(visible);
        if(!cue) { expect(++stalled).toBeLessThan(240);visible.shift();continue; }
        expect(seen.has(cue.word)).toBe(false);seen.add(cue.word);
        expect(visible.some(v=>v.group===cue.group)).toBe(false);visible.push(cue);
      }
      expect(seen.size).toBe(cues.length);
    }
  }
});
it('keeps independent clouds separated, contained and moving right while their shapes change', () => {
  for(const [width,textWidth,lineHeight] of [[844,116,24.3],[704,116,24.3],[320,116,24.3],[704,174,36.45]]) {
    const layout=cloudLayout(width,textWidth,lineHeight),flow=new WordCloudFlow(random(9));
    flow.resize(layout,new Map(cues.map(c=>[c.word,c.word.length*textWidth/14])));
    expect(flow.visible.length).toBeGreaterThan(3);
    if(width>=704&&lineHeight<25) expect(new Set(flow.items.filter(i=>i.cue).map(i=>i.cloud.id)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(flow.items.map(i=>i.point.font)).size).toBeGreaterThanOrEqual(4);
    let shapeChanged=false;
    for(let time=0;time<600;time+=2) {
      const items=flow.items.filter(i=>i.cue&&i.position.opacity>0);
      items.forEach(({cloud,point,position:p},i)=>{
        cloud.x+=.04*layout.scale;
        const next=cloudPosition(layout,cloud,point,flow.time+.01);cloud.x-=.04*layout.scale;
        expect(next.x).toBeGreaterThan(p.x);
        if(Math.abs(next.y-p.y)>.001) shapeChanged=true;
        expect(p.y-point.height/2).toBeGreaterThanOrEqual(0);
        expect(p.y+point.height/2).toBeLessThanOrEqual(layout.height);
        expect(p.x-point.width/2).toBeGreaterThanOrEqual(0);
        expect(p.x+point.width/2).toBeLessThanOrEqual(layout.width);
        for(let j=i+1;j<items.length;j++)
          expect(Math.abs(p.x-items[j].position.x)>=(point.width+items[j].point.width)/2 || Math.abs(p.y-items[j].position.y)>=(point.height+items[j].point.height)/2).toBe(true);
      });
      flow.advance(2);
    }
    expect(shapeChanged).toBe(true);
  }
});
it('continually emits newly shaped clouds and consumes complete bags without repeating active groups', () => {
  const flow=new WordCloudFlow(random(8)),draw=vi.spyOn(flow.deck,'draw');
  flow.resize(cloudLayout(844,116,24.3),new Map(cues.map(c=>[c.word,c.word.length*8])));
  const original=flow.clusters.map(c=>c.id),shapes=new Set<string>();
  for(let time=0;time<12_000;time+=2) {
    flow.advance(2);
    expect(flow.clusters.length).toBeGreaterThan(0);expect(flow.clusters.length).toBeLessThan(7);
    expect(flow.visible.length).toBeGreaterThanOrEqual(3);
    expect(new Set(flow.visible.map(c=>c.group)).size).toBe(flow.visible.length);
    flow.clusters.forEach(c=>shapes.add(`${c.width.toFixed(1)}:${c.height}:${c.points.length}`));
    if(time>300) expect(flow.clusters.every(c=>!original.includes(c.id))).toBe(true);
  }
  const drawn=draw.mock.results.flatMap(r=>r.value?[r.value.word]:[]);
  expect(drawn.length).toBeGreaterThan(480);
  for(let i=0;i+240<=drawn.length;i+=240) expect(new Set(drawn.slice(i,i+240)).size).toBe(240);
  expect(shapes.size).toBeGreaterThan(30);
  flow.advance(10_000);flow.advance(100);
  expect(flow.visible.length).toBeGreaterThan(0);
});
it('uses genuine submission, retaining text/openers and excluding legacy/ended chats', () => {
  const view={session:{state:'draft',draft:'My thought'},messages:[{role:'assistant',origin:'starter'}],opener:{generated:true}} as SessionView;
  expect(cloudSession(view)).toEqual({supported:true,submitted:false,ended:false});
  expect(cloudSession({...view,messages:[{role:'user',origin:'learner'} as any]}).submitted).toBe(true);
  expect(cloudSession({...view,session:{...view.session,state:'active'}}).submitted).toBe(true);
  expect(cloudSession({...view,session:{...view.session,state:'ended'}}).ended).toBe(true);
  expect(cloudSession({...view,opener:undefined}).supported).toBe(false);
});
