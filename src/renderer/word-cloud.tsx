import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cues } from './word-cloud-selection';
import { cloudLayout, WordCloudFlow } from './word-cloud-flow';
// Session-local presentation only; no IPC, persistence or provider dependency.
const flows = new Map<string, WordCloudFlow>();
function flowFor(id: string) {
  if (!flows.has(id)) {
    if (flows.size >= 8) flows.delete(flows.keys().next().value!);
    flows.set(id, new WordCloudFlow());
  }
  return flows.get(id)!;
}
export function WordCloud({ sessionId, enabled, supported, submitted, ended, paused = false }: {
  sessionId: string; enabled: boolean | undefined; supported: boolean; submitted: boolean; ended: boolean; paused?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const committed = useRef(submitted || ended);
  const shown = useRef(false);
  const [flow] = useState(() => !committed.current && supported ? flowFor(sessionId) : null);
  const [, render] = useState(0);
  const [geometry, setGeometry] = useState('');
  const anchors = useRef(new Map<string,HTMLSpanElement>());
  const [exiting, setExiting] = useState(false), [absent, setAbsent] = useState(committed.current);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [obscured, setObscured] = useState(document.hidden);
  const show = !!enabled && supported && !ended && !absent && !!flow;
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const visibility = () => setObscured(document.hidden || !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'));
    const observer = new MutationObserver(visibility);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'role'] });
    media.addEventListener('change', motion); document.addEventListener('visibilitychange', visibility); visibility();
    return () => { observer.disconnect(); media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useLayoutEffect(() => {
    if (!show || !root.current || !flow || exiting) return;
    const node = root.current;
    const measure = () => {
      const font = getComputedStyle(node), context = document.createElement('canvas').getContext('2d')!;
      context.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      const widths = new Map(cues.map(cue => [cue.word, context.measureText(cue.word).width]));
      const width = Math.max(...widths.values());
      const lineHeight = parseFloat(font.lineHeight);
      if (!node.clientWidth) return;
      const key = `${node.clientWidth}/${width}/${lineHeight}`;
      if (!flow.layout || flow.layout.width !== node.clientWidth || flow.layout.wordWidth !== width || flow.layout.lineHeight !== lineHeight)
        flow.resize(cloudLayout(node.clientWidth, width, lineHeight), widths);
      setGeometry(key); render(value => value + 1);
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    const text = node.querySelector('.word-cloud-measure'); if (text) observer.observe(text);
    let alive = true; void document.fonts.ready.then(() => { if (alive) measure(); });
    return () => { alive = false; observer.disconnect(); };
  }, [show, flow, exiting]);
  useLayoutEffect(() => {
    if (submitted || ended) {
      if (!committed.current) {
        committed.current = true; flows.delete(sessionId);
        if (shown.current && show && !reduced && !paused && !obscured) setExiting(true);
        else setAbsent(true);
      }
    } else if (show && !committed.current) shown.current = true;
  }, [submitted, ended, show, reduced, paused, obscured, sessionId]);
  useEffect(() => {
    if (!exiting || absent || !root.current) return;
    if (reduced || !enabled || obscured || paused) { setAbsent(true); return; }
    const node = root.current, animations: Animation[] = [];
    const box = node.getBoundingClientRect();
    // Stop the flow at its current position; scatter its separate inner layer.
    for (const [index, slot] of [...node.querySelectorAll<HTMLElement>('.word-cloud-slot')].entries()) {
      const bounds = slot.querySelector('.word-cloud-drift')!.getBoundingClientRect();
      const outwardX = (bounds.left + bounds.width / 2 < box.left + box.width / 2 ? -1 : 1) * 20;
      const dx = Math.max(box.left - bounds.left, Math.min(box.right - bounds.right, outwardX));
      const outwardY = (bounds.top + bounds.height / 2 < box.top + box.height / 2 ? -1 : 1) * 18;
      const dy = Math.max(box.top - bounds.top, Math.min(box.bottom - bounds.bottom, outwardY));
      const opacity = getComputedStyle(slot).opacity;
      animations.push(slot.animate([{ transform: 'translate(0,0)', opacity },
        { transform: `translate(${dx}px,${dy}px)`, opacity: 0 }],
      { duration: 950 + (index % 6) * 35, easing: 'cubic-bezier(.2,.6,.3,1)', fill: 'forwards' }));
    }
    animations.push(node.animate([{ height: `${node.offsetHeight}px` }, { height: '0px' }],
      { delay: 1150, duration: 250, easing: 'cubic-bezier(.4,0,.4,1)', fill: 'forwards' }));
    const timer = setTimeout(() => setAbsent(true), 1400);
    return () => { clearTimeout(timer); animations.forEach(animation => animation.cancel()); };
  }, [exiting, absent, reduced, enabled, obscured, paused]);
  useEffect(() => {
    if (!show || !flow?.layout || reduced || paused || obscured || exiting || committed.current) return;
    let frame = 0, last = 0;
    const animate = (now: number) => {
      if (last && flow.advance(Math.min((now - last) / 1000, .05))) render(value => value + 1);
      last = now;
      for (const item of flow.items) {
        const node=anchors.current.get(item.id);if(!node)continue;
        node.style.transform=`translate(${item.position.x}px,${item.position.y}px)`;
        node.style.opacity=String(item.position.opacity);
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [show, flow, geometry, reduced, paused, obscured, exiting]);
  if (!show) return null;
  return <div ref={root} className={`word-cloud${exiting ? ' exiting' : ''}`} aria-hidden="true"
    data-paused={reduced || paused || obscured || exiting} data-capacity={flow?.items.length ?? 0} data-clouds={flow?.clusters.length ?? 0}
    style={{ height: flow?.layout?.height ?? 0 }}>
    <span className="word-cloud-measure">subscription</span>
    {flow?.layout && flow.items.map(({id,cloud,point,cue,position}) =>
      <span className="word-cloud-anchor" key={id} data-cloud={cloud.id}
        ref={node => { if(node) anchors.current.set(id,node); else anchors.current.delete(id); }}
        style={{transform:`translate(${position.x}px,${position.y}px)`,opacity:position.opacity,fontSize:point.font,lineHeight:`${point.height}px`}}>
        <span className="word-cloud-slot"><span className="word-cloud-drift">{cue?.word ?? ''}</span></span>
      </span>
    )}
  </div>;
}
