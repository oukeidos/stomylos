import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {RequestHistoryRows} from '../src/renderer/request-history';
import type {RequestAttempt} from '../src/shared/request-history';
const base:RequestAttempt={id:'a',kind:'Memory update · Input 1',createdAt:'2026-09-11T00:00:00Z',model:'openai/gpt-5.6-luna',settings:{reasoning:{effort:'none'}},status:'interrupted',metadata:{}};
const render=(attempts:RequestAttempt[])=>renderToStaticMarkup(createElement(RequestHistoryRows,{history:{attempts,notices:[]},errorText:x=>x}));
it('renders each ADD attempt and reported usage without inventing missing costs',()=>{
 const html=render([base,{...base,id:'b',status:'succeeded',metadata:{model:base.model,provider:'Example',elapsed_seconds:1.23,usage:{total_tokens:250,completion_tokens:30,cost:0.00123}}}]);
 expect(html).toContain('Input 1');expect(html.match(/Memory update/g)).toHaveLength(2);expect(html).toContain('interrupted');expect(html).toContain('succeeded');expect(html).toContain('total tokens');expect(html).toContain('output tokens');expect(html).toContain('1.23');expect(html).toContain('$0.001230');expect(html.match(/\$/g)).toHaveLength(1);
});
it.each(['request_timeout','transport_failed'])('shows uncertain billing for %s failures and omits it for known unsent attempts',failure=>{
 const row={...base,status:'failed',metadata:{elapsed_seconds:2.4},failure};
 const html=render([row]);expect(html).toContain('may already have been billed');expect(html).toContain('2.40');
 const unsent=render([{...row,status:'interrupted',failure:'queued_not_dispatched'}]);expect(unsent).not.toContain('may already have been billed');
});
