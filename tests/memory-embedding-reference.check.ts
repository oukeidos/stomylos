import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env,pipeline } from '@huggingface/transformers';
import { loadEmbedding } from '../src/main/memory-embedding';
import { dot } from '../src/main/memory-vectors';
import topics from './fixtures/cold-memory/topics.json';
it('compares explicit CLS output with the library reference and bounds q8 drift against the same pinned FP32 checkpoint',async()=>{
 const fp32='/tmp/stomylos-cold-fp32-reference';
 expect(createHash('sha256').update(readFileSync(fp32+'/onnx/model.onnx')).digest('hex')).toBe('828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35');
 env.allowRemoteModels=false;env.allowLocalModels=true;env.useFSCache=false;
 const directory=resolve('assets/memory-model'),engine=await loadEmbedding(directory),texts=Object.values(topics).flat().filter((_,i)=>i%5===0),vectors=[];
 const q8Reference=await pipeline('feature-extraction',directory,{local_files_only:true,dtype:'q8',device:'cpu'});
 try {for(const text of texts){const v=await engine.embed(text);vectors.push(v.vector);const expected=await q8Reference(text,{pooling:'cls',normalize:true});expect(dot(v.vector,Array.from(expected.data,Number))).toBeGreaterThan(0.99999);}}
 finally {await q8Reference.dispose();}
 const reference=await pipeline('feature-extraction',fp32,{local_files_only:true,dtype:'fp32',device:'cpu'}),drift=[];
 try{for(let i=0;i<texts.length;i++){const expected=await reference(texts[i],{pooling:'cls',normalize:true});drift.push(1-dot(vectors[i],Array.from(expected.data,Number)));}}
 finally{await reference.dispose();}
 const stats=[];
 try{for(const contentTokens of [126,510]){const ms=[];for(let i=0;i<10;i++){const start=performance.now(),result=await engine.embed('hello '.repeat(contentTokens));ms.push(performance.now()-start);expect(result.chunkCount).toBe(1);}ms.sort((a,b)=>a-b);stats.push({tokensIncludingSpecial:contentTokens+2,samples:10,p95Ms:ms[9],p50Ms:ms[5]});}}
 finally{await engine.close();}
 mkdirSync('test-results/cold-memory',{recursive:true});writeFileSync('test-results/cold-memory/reference.json',JSON.stringify({referenceRevision:'ea104dacec62c0de699686887e3f920caeb4f3e3',referenceSha256:'828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',samples:drift.length,clsAgreementCosineMin:0.99999,maxQ8CosineDistance:Math.max(...drift),meanQ8CosineDistance:drift.reduce((a,b)=>a+b,0)/drift.length,warmEmbedding:stats,providerRequests:0},null,2));
 expect(Math.max(...drift)).toBeLessThan(0.05);expect(stats[0].p95Ms).toBeLessThanOrEqual(250);
},90000);
