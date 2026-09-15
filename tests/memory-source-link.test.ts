import {expect,it} from 'vitest';
import {linkBatches,validateSources,sourceOrder} from '../src/main/memory-source-link';
it('uses the fixed non-reasoning contract and validates record completeness',()=>{
 const conversation=[{role:'user',content:'I have a camera.'},{role:'assistant',content:'Which?'},{role:'user',content:'A green one.'}];
 const [body]=linkBatches(conversation,['I have a green camera.']);
 expect(body.model).toBe('openai/gpt-5.6-luna');expect(body.reasoning).toEqual({effort:'none',exclude:true});expect(body.max_tokens).toBe(4096);
 expect(JSON.parse(body.messages[1].content)).toEqual({conversation:[[1,'user','I have a camera.'],[2,'assistant','Which?'],[3,'user','A green one.']],records:[[1,'I have a green camera.']]});
 expect(validateSources(body,'{"sources":[{"id":1,"ids":[3,1,3]}]}')).toEqual([{id:1,ids:[1,3]}]);
 for(const sources of [[],[{id:1,ids:[]}],[{id:1,ids:[4]}],[{id:2,ids:[1]}],[{id:1,ids:[1]},{id:1,ids:[3]}]])expect(()=>validateSources(body,JSON.stringify({sources}))).toThrow();
});
it('orders by latest user source, keeps ties stable and falls back to assistant source',()=>{
 const conversation=[{role:'user'},{role:'assistant'},{role:'user'},{role:'assistant'}];
 expect(sourceOrder(conversation,[{id:1,ids:[1,3,4]},{id:2,ids:[1]},{id:3,ids:[2]},{id:4,ids:[3]}])).toEqual([1,2,0,3]);
});
it('bounds large escaped input and output without truncating or renumbering records',()=>{
 const c=Array.from({length:1025},(_,i)=>({role:i%2?'assistant':'user',content:'\\\"🙂'}));
 const records=Array.from({length:80},()=> 'A'.repeat(2900));const bodies=linkBatches(c,records);
 expect(bodies.length).toBeGreaterThan(1);
 const ids=bodies.flatMap(b=>JSON.parse(b.messages[1].content).records.map((r:any)=>r[0]));expect(ids).toEqual(records.map((_,i)=>i+1));
 for(const b of bodies){expect(b.max_tokens).toBeLessThanOrEqual(128000);expect(Buffer.byteLength(JSON.stringify(b))+8192+b.max_tokens).toBeLessThanOrEqual(1050000);expect(JSON.parse(b.messages[1].content).conversation).toHaveLength(1025);}
 expect(()=>linkBatches([{role:'user',content:'a'.repeat(1000000)}],['x'])).toThrow('memory_source_input_limit');
 expect(linkBatches(c,[])).toEqual([]);
});
it('bounds the maximum record count and item size with a full-size transcript',()=>{
 const c=Array.from({length:1025},(_,i)=>({role:i%2?'assistant':'user',content:'x'.repeat(i===1024?32768:155)}));
 const records=Array.from({length:4096},()=> 'x'.repeat(2998)),bodies=linkBatches(c,records);
 expect(bodies.flatMap(b=>JSON.parse(b.messages[1].content).records)).toHaveLength(4096);
 for(const body of bodies){
  const props=body.response_format.json_schema.schema.properties.sources.items.properties;
  expect(props.ids.items).toEqual({type:'integer',minimum:1,maximum:1025});
  expect(props.id.enum).toBeUndefined();
  expect(body.max_tokens).toBeLessThanOrEqual(128000);expect(Buffer.byteLength(JSON.stringify(body))+8192+body.max_tokens).toBeLessThanOrEqual(1050000);}
},30000);
