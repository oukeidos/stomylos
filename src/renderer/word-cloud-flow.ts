import { WordCloudDeck, type Cue } from './word-cloud-selection';
export interface CloudLayout { width: number; height: number; wordWidth: number; lineHeight: number; scale: number }
export interface CloudPoint { x: number; y: number; width: number; height: number; font: number; phase: number; cue: Cue | null; done: boolean; appeared: number }
export interface CloudCluster { id: number; x: number; y: number; width: number; height: number; phase: number; points: CloudPoint[] }
export interface CloudPosition { x: number; y: number; opacity: number }
export function cloudLayout(width: number, wordWidth: number, lineHeight: number): CloudLayout {
  const scale = lineHeight / 24.3;
  return {width,height:360*scale,wordWidth,lineHeight,scale};
}
export function cloudPosition(layout: CloudLayout, cloud: CloudCluster, point: CloudPoint, time: number): CloudPosition {
  const s=layout.scale;
  const x=cloud.x+point.x+(point.x/cloud.width-.5)*32*s*Math.sin(time*.08+cloud.phase)+3*s*Math.sin(time*.1+point.phase);
  const y=cloud.y+point.y+(point.y/cloud.height-.5)*40*s*Math.sin(time*.085+cloud.phase)+3*s*Math.sin(time*.14+point.phase);
  const edge=28*s;
  const spatial=Math.max(0,Math.min(1,(x-point.width/2)/edge,(layout.width-x-point.width/2)/edge));
  const appearance=point.cue?Math.min(1,Math.max(0,(time-point.appeared)/.5)):0;
  return {x,y,opacity:spatial*appearance};
}
/** Independent, newly shaped clouds are emitted ahead of the leading edge. */
export class WordCloudFlow {
  readonly deck: WordCloudDeck;
  layout: CloudLayout | null = null;
  clusters: CloudCluster[] = [];
  time = 0;
  private serial = 0;
  private widths: ReadonlyMap<string,number> = new Map();
  constructor(private random: () => number = Math.random) { this.deck=new WordCloudDeck(random); }
  private create(): CloudCluster {
    const layout=this.layout!,s=layout.scale,r=this.random;
    const width=Math.min(layout.width-24*s,Math.max(280*s,layout.width*(.38+r()*.14)));
    const count=width/s>380?12:width/s>310?10:8;
    const phase=r()*Math.PI*2;
    const fonts=[28,14,22,16,25,15,18,16,14,20,13,17].slice(0,count);
    for(let i=fonts.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[fonts[i],fonts[j]]=[fonts[j],fonts[i]];}
    const templates=fonts.map(font=>{
      const reservation=font<=16?1:.55+r()*.2;
      return {font:font*s,width:layout.wordWidth*font/18*reservation,height:font*s*1.35};
    }).sort((a,b)=>b.width-a.width);
    let chosen: CloudPoint[]=[],height=0;
    for(let h=160*s;h<=layout.height-40*s;h+=20*s) {
      const points: CloudPoint[]=[];
      // Independently vary two overlapping lobes, rather than reusing one contour.
      const skew=(r()-.5)*.22, lobes=[[.34+skew,.45,.31,.36],[.67+skew,.56,.28,.32]];
      for(const template of templates) {
        for(let attempt=0;attempt<2000;attempt++) {
          const lobe=lobes[Math.floor(r()*2)],a=r()*Math.PI*2,radius=Math.sqrt(r());
          const x=lobe[0]*width+Math.cos(a)*radius*lobe[2]*width;
          const y=lobe[1]*h+Math.sin(a)*radius*lobe[3]*h;
          if(x<template.width/2+22*s || x>width-template.width/2-22*s || y<template.height/2+24*s || y>h-template.height/2-24*s) continue;
          // Reserve the full relative deformation, plus a readable 8px gap.
          if(points.some(p=>{
            const dx=Math.abs(p.x-x),dy=Math.abs(p.y-y);
            return dx<(p.width+template.width)/2+14*s+dx/width*32*s && dy<(p.height+template.height)/2+14*s+dy/h*40*s;
          })) continue;
          points.push({...template,x,y,phase:r()*Math.PI*2,cue:null,done:false,appeared:0});break;
        }
      }
      if(points.length>chosen.length){chosen=points;height=h;}
      if(chosen.length===count) break;
    }
    const room=Math.max(0,(layout.height-height)/2-16*s);
    return {id:++this.serial,x:0,y:(layout.height-height)/2+(r()-.5)*2*room,width,height,phase,points:chosen};
  }
  resize(layout: CloudLayout, widths: ReadonlyMap<string,number>) {
    this.layout=layout;this.widths=widths;this.clusters=[];this.time=0;
    let x=12*layout.scale;
    while(x<layout.width) {
      const cloud=this.create();cloud.x=x;this.clusters.push(cloud);x+=cloud.width+24*layout.scale;
    }
    this.incoming();this.fill(true);
  }
  private incoming() {
    if(!this.clusters.length){const cloud=this.create();cloud.x=-cloud.width;this.clusters.push(cloud);}
    const first=this.clusters[0];
    if(first&&first.x>0) {
      const cloud=this.create();cloud.x=first.x-cloud.width-24*this.layout!.scale;this.clusters.unshift(cloud);
    }
  }
  get items() {
    return this.clusters.flatMap(cloud=>cloud.points.map((point,i)=>({id:`${cloud.id}-${i}`,cloud,point,cue:point.cue,
      position:cloudPosition(this.layout!,cloud,point,this.time)})));
  }
  get visible(): Cue[] { return this.clusters.flatMap(c=>c.points.flatMap(p=>p.cue?[p.cue]:[])); }
  private fill(initial=false): boolean {
    let changed=false;
    // Release fully faded outgoing words before admitting incoming ones.
    for(const cloud of this.clusters) for(const point of cloud.points) {
      const p=cloudPosition(this.layout!,cloud,point,this.time);
      if(p.x>=this.layout!.width-point.width/2) {
        if(point.cue){point.cue=null;changed=true;}point.done=true;
      }
    }
    const pending=this.items.filter(item=>!item.point.done&&!item.point.cue).sort((a,b)=>a.point.width/a.point.font-b.point.width/b.point.font);
    for(const {point,position} of pending) {
      if(position.x<point.width/2 || position.x>=this.layout!.width-point.width/2) continue;
      const cue=this.deck.draw(this.visible,cue=>(this.widths.get(cue.word)??Infinity)*point.font/(18*this.layout!.scale)<=point.width);
      if(cue){point.cue=cue;point.appeared=initial?this.time-1:this.time;changed=true;}
    }
    return changed;
  }
  advance(seconds: number): boolean {
    if(!this.layout)return false;
    const dt=Math.max(0,seconds);this.time+=dt;
    for(const cloud of this.clusters)cloud.x+=dt*4*this.layout.scale;
    const before=this.clusters.length,serial=this.serial;
    this.clusters=this.clusters.filter(cloud=>cloud.x<this.layout!.width+24*this.layout!.scale);
    this.incoming();
    return this.fill()||before!==this.clusters.length||serial!==this.serial;
  }
}
