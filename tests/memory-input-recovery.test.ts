import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {MemoryInputRecovery, memoryInputProgress} from '../src/renderer/memory-input-recovery';
it('offers exact-input actions for failed work only and locks both during saving',()=>{
 const jobs=[{ordinal:3,session_id:'s',state:'failed',failure:'request_timeout'},{ordinal:4,session_id:'s',state:'pending'},{ordinal:5,session_id:'s',state:'completed'}];const onAction=vi.fn();
 const html=renderToStaticMarkup(createElement(MemoryInputRecovery,{jobs,disabled:true,onAction}));
 expect(html).toContain('Memory input 3');expect(html).not.toContain('Memory input 4');expect(html).not.toContain('Memory input 5');expect(html).toContain('Retry input');expect(html).toContain('Skip input');expect(html.match(/disabled=""/g)).toHaveLength(2);expect(html).toContain('may already have been billed');
 // Exercise the same callbacks passed to both End and Settings, including the exact job object.
 const element=MemoryInputRecovery({jobs,disabled:false,onAction});
 const section=element.props.children[0];const buttons=section.props.children[2].props.children;
 buttons[0].props.onClick();buttons[1].props.onClick();expect(onAction.mock.calls).toEqual([['retryMemoryAdd',jobs[0]],['skipMemoryAdd',jobs[0]]]);
});

it('summarizes unfinished inputs without confusing this chat with an earlier blocker', () => {
 const jobs = ['pending','running','received','failed','interrupted','completed','skipped'].map(state => ({state}));
 expect(memoryInputProgress(jobs, 'current', 'current')).toEqual({summary:'3 pending · 2 needs attention',earlierChat:null});
 expect(memoryInputProgress(jobs, 'current', 'earlier').earlierChat).toBe('earlier');
 expect(memoryInputProgress([{state:'failed'}], 'current', 'earlier')).toEqual({summary:'1 needs attention',earlierChat:null});
 for(const settled of [[],[{state:'completed'},{state:'skipped'}]]) {
  expect(memoryInputProgress(settled, 'current', 'earlier')).toEqual({summary:undefined,earlierChat:null});
 }
});
