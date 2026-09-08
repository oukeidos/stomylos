import { patternHash, selectPatternScope } from '../src/main/pattern-report';
import type { PatternSource } from '../src/shared/pattern-report';
export const at='2026-09-05T12:00:00.000Z';
export function session(id:string, units:[string,string,string][], i:number):PatternSource {
  const mapped=units.map(([original,corrected,explanation],n)=>({source_id:'E-'+patternHash(JSON.stringify([id,`${id}-analysis`,`${id}-M${n+1}`])).slice(0,24),message_id:`${id}-M${n+1}`,ordinal:n,original,corrected,explanation}));
  return {session_id:id,analysis_id:`${id}-analysis`,ended_at:new Date(Date.parse(at)-i*86400000).toISOString(),units:mapped,source_hash:patternHash(JSON.stringify(mapped))};
}
export function patternQualityCases() {
  const mixed=Array.from({length:20},(_,i)=>session(`Q1-S${String(i+1).padStart(2,'0')}`,[
    [`Yesterday I go to the ${['market','library','station','museum'][i%4]}.`,`Yesterday I went to the ${['market','library','station','museum'][i%4]}.`,'The trip happened yesterday and is complete. Use the past form went.'],
    ['Could you give me an advice about the trip?','Could you give me some advice about the trip?','Advice is uncountable here; some advice requests an unspecified amount.'],
    ['Could you tell me where is the station?','Could you tell me where the station is?','This is an embedded question after could you tell me. Use subject before verb.'],
    [`I was interested in the ${['street','garden','painting','book'][i%4]}. I took my time and noticed something new. The visit gave me a useful pause after a busy week.`,`I was interested in the ${['street','garden','painting','book'][i%4]}. I took my time and noticed something new. The visit gave me a useful pause after a busy week.`,'']
  ],i));
  const clustered=Array.from({length:6},(_,i)=>session(`Q2-S${i+1}`,i===0?
    Array.from({length:10},(_,j)=>[`Last week I go to the ${['market','library','station','museum','park'][j%5]}.`,`Last week I went to the ${['market','library','station','museum','park'][j%5]}.`,'A completed past event requires went.'] as [string,string,string]):i<3?
    [['I need an advice about my work.','I need some advice about my work.','Advice is uncountable in this request.']]:
    [['I enjoy quiet afternoons.','I enjoy quiet afternoons.','']],i));
  const sparse=['I enjoyed a walk yesterday.','There are several books on the table.','Could you tell me where the library is?','I would like some advice.','I am interested in learning about local history.']
    .map((text,i)=>session(`Q3-S${i+1}`,[[text,text,'']],i));
  const rows=[{id:'Q1',sources:mixed,expectation:'Up to three supported patterns: finished past, uncountable advice, embedded question order. Preserve unchanged examples as acceptable.'},
    {id:'Q2',sources:clustered,expectation:'Zero recurring patterns. Ten past-tense errors occur in only one session; advice appears in only two. Do not merge unrelated errors into a generic three-session pattern.'},
    {id:'Q3',sources:sparse,expectation:'Zero recurring patterns. All five records are unchanged. No substitute lessons or invented errors.'}]
    .map(row=>{const selected=selectPatternScope(row.sources,at);return {...row,...selected};});
  return rows;
}
