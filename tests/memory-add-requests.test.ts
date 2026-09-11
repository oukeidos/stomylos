import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {MemoryAddRequests} from '../src/renderer/memory-add-requests';
it('renders each attempt and reported usage without inventing missing costs',()=>{
 const base={id:'a',job_id:1,message_id:'user',created_at:'2026-09-11T00:00:00Z',model:'openai/gpt-5.6-luna',reasoning:'none',failure:null};
 const html=renderToStaticMarkup(createElement(MemoryAddRequests,{attempts:[{...base,status:'interrupted',metadata:'{}'},
 {...base,id:'b',status:'succeeded',metadata:JSON.stringify({model:base.model,provider:'Example',elapsed_seconds:1.23,usage:{total_tokens:250,completion_tokens:30,cost:0.00123}})}]}));
 expect(html.match(/Memory update/g)).toHaveLength(2);expect(html).toContain('interrupted');expect(html).toContain('succeeded');expect(html).toContain('250 tokens');expect(html).toContain('30 output tokens');expect(html).toContain('1.2 seconds');expect(html).toContain('$0.00123');expect(html.match(/\$/g)).toHaveLength(1);
});

it.each(['request_timeout','transport_failed'])('shows uncertain billing for %s failures and omits it for known unsent attempts',failure=>{
 const row={id:'a',job_id:1,message_id:'m',created_at:'2026-09-11T00:00:00Z',model:'luna',reasoning:'none',status:'failed' as const,metadata:'{"elapsed_seconds":2.4}',failure};
 const html=renderToStaticMarkup(createElement(MemoryAddRequests,{attempts:[row]}));expect(html).toContain('may already have been billed');expect(html).toContain('2.4 seconds');
 const unsent=renderToStaticMarkup(createElement(MemoryAddRequests,{attempts:[{...row,status:'interrupted',failure:'queued_not_dispatched'}]}));expect(unsent).not.toContain('may already have been billed');
});
