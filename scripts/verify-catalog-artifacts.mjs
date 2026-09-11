import { parse } from '@babel/parser';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const old=readFileSync('src/main/assets/starter-catalog-v1.json','utf8'),latest=readFileSync('src/main/assets/starter-catalog-current.json','utf8');
let oldCount=0,currentCount=0;
function visit(n){
 if(!n||typeof n!=='object')return;
 const value=n.type==='StringLiteral'?n.value:n.type==='TemplateLiteral'&&!n.expressions.length?n.quasis.map(q=>q.value.cooked).join(''):undefined;
 if(value===old)oldCount++;if(value===latest)currentCount++;
 for(const [k,v] of Object.entries(n))if(k!=='loc'&&k!=='extra'){if(Array.isArray(v))v.forEach(visit);else if(typeof v==='object')visit(v);}
}
function scan(dir){for(const name of readdirSync(dir,{withFileTypes:true})){const p=join(dir,name.name);if(name.isDirectory())scan(p);else if(p.endsWith('.js'))visit(parse(readFileSync(p,'utf8'),{sourceType:'module'}));}}
scan('out/main');if(oldCount!==0||currentCount!==1)throw Error(JSON.stringify({oldCount,currentCount}));
const manifest=JSON.parse(readFileSync('src/main/assets/starter-catalog-v1-manifest.json','utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
if(hash(old)!==manifest.sha256)throw Error('Frozen v1 payload hash mismatch');
const delta=JSON.parse(readFileSync('src/main/assets/starter-catalog-v1-delta.json','utf8'));
const restored=JSON.stringify(JSON.parse(latest).map(r=>({...r,en:delta[r.id]??r.en})))+'\n';
if(restored!==old)throw Error('Reconstruction mismatch');
mkdirSync('test-results/catalog-updates',{recursive:true});
const report={completeCurrentPayloads:currentCount,completeV1Payloads:oldCount,reverseDeltaRows:Object.keys(delta).length,v1ReconstructionSha256:hash(restored),currentManifest:JSON.parse(readFileSync('src/main/assets/starter-catalog-current-manifest.json','utf8'))};
writeFileSync('test-results/catalog-updates/artifacts.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({completeCurrentPayloads:currentCount,completeV1Payloads:oldCount,reverseDeltaRows:Object.keys(delta).length,v1Reconstruction:'exact'}));
