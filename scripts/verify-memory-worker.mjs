// Focused local-only utility-process check; no app DB, credentials or provider.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const executable=createRequire(import.meta.url)('electron');
const directory=await mkdtemp('/tmp/stomylos-memory-worker-');
const entry=join(directory,'main.cjs');
await writeFile(entry,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(join(directory,'profile'))});app.whenReady();`);
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('STOMYLOS_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
let app;
try {
  app=await electron.launch({executablePath:executable,args:[entry],env,chromiumSandbox:true,timeout:20000});
  const report=await app.evaluate(async({utilityProcess,app:electronApp},args)=>{
    const started=Date.now(),worker=utilityProcess.fork(args.entry,[],{stdio:'pipe',serviceName:'Memory verification'});
    let log='';worker.stderr.on('data',part=>{log+=part.toString();});
    const send=(id,method,data)=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{worker.kill();reject(new Error(`Worker deadline: ${log}`));},60000);
      const listener=result=>{if(result.id!==id)return;clearTimeout(timer);worker.off('message',listener);result.error?reject(new Error(`${result.error}: ${log}`)):resolve(result.result);};
      worker.on('message',listener);worker.postMessage({id,method,...data});
    });
    try {
      await send(1,'init',{directory:args.directory});const initializedMs=Date.now()-started;
      const result=await send(2,'embed',{text:'The user enjoys hiking on weekends.'});
      for(let i=0;i<8;i++)await send(3+i,'embed',{text:'The user enjoys mountain hiking. '.repeat(160)});
      const memory=electronApp.getAppMetrics().find(metric=>metric.pid===worker.pid)?.memory;
      return {memory,longInputJobs:8,initializedMs,totalMs:Date.now()-started,dimensions:result.vector.length,norm:Math.sqrt(result.vector.reduce((s,x)=>s+x*x,0)),chunks:result.chunkCount};
    } finally {await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Worker did not exit')),2000);worker.once('exit',()=>{clearTimeout(timeout);resolve();});worker.kill();});}
  },{entry:resolve('out/main/memory-embedding-worker.js'),directory:resolve('assets/memory-model')});
  assert.equal(report.dimensions,384);assert.ok(Math.abs(report.norm-1)<1e-3);assert.equal(report.chunks,1);
  await mkdir('test-results/cold-memory',{recursive:true});
  await writeFile('test-results/cold-memory/worker.json',JSON.stringify({status:'passed',...report,providerRequests:0},null,2));
  console.log(JSON.stringify({status:'passed',...report,providerRequests:0}));
} finally {if(app)await app.close();await rm(directory,{recursive:true,force:true});}
