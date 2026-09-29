import 'reflect-metadata';
import {PrismaClient} from '@prisma/client';
import {ConfigService} from '@nestjs/config';
import {Test} from '@nestjs/testing';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
const url=process.env.TEST_DATABASE_URL;
if(!url||!['localhost','127.0.0.1'].includes(new URL(url).hostname)||!/^\/mandaria_a6_load_[a-f0-9]+_test$/.test(new URL(url).pathname))throw Error('Exclusive A6 load DB required');
process.env.DATABASE_URL=url;process.env.NODE_ENV='test';process.env.PREQUOTE_ENABLED='true';process.env.PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS='1000000';process.env.B2B_WEBHOOK_POLL_SECONDS='0';process.env.MAIL_PROVIDER='local_outbox';process.env.ROUTING_PROVIDER='local_fake';
for(const k of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','INTEGRATION_JWT_SECRET'])process.env[k]=randomBytes(48).toString('hex');
const {AppModule}=await import('../dist/app.module.js');
const {PREQUOTE_CONSUMPTION}=await import('../dist/delivery-prequotes/prequote-consumption.js');
const {ROUTING_PROVIDER}=await import('../dist/routing/routing.types.js');
const apps=[];let routingCalls=0;
const limits={minute:10000,day:1000000,concurrent:100,globalUnits:1000000,reserveMs:1000,retries:0,timeoutMs:1000};
const fingerprint=createHash('sha256').update(JSON.stringify(limits)).digest('hex');
async function app(){const ref=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(ROUTING_PROVIDER).useValue({name:'a6-load',calculateRoute:async()=>{routingCalls++;throw Error('No load routing expected')}}).setLogger(false).compile();const a=ref.createNestApplication({logger:false});await a.init();const c=a.get(ConfigService);for(const [k,v] of Object.entries({PREQUOTE_PER_MINUTE:limits.minute,PREQUOTE_PER_DAY:limits.day,PREQUOTE_MAX_CONCURRENT:limits.concurrent,PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS:limits.globalUnits,PREQUOTE_PERMIT_RESERVE_MS:limits.reserveMs,GOOGLE_ROUTES_MAX_RETRIES:limits.retries,GOOGLE_ROUTES_TIMEOUT_MS:limits.timeoutMs}))c.set(k,v);apps.push(a);return a.get(PREQUOTE_CONSUMPTION)}
const p=new PrismaClient({datasourceUrl:url});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
if(process.argv[2]==='child'){
 const service=await app();const id=process.argv[3];const phase=process.argv[4];const r=await service.admit(id);assert(r.admitted);if(phase==='started')await r.permit.start();process.send({ready:true,phase});await new Promise(()=>{});
}else{
 const results={environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,memoryGB:Math.round(os.totalmem()/1024**3),database:new URL(url).pathname.slice(1)},crashes:[],load:[]};
 try{
 const services=[await app(),await app()];assert.notEqual(services[0],services[1]);
 await p.prequoteConsumptionPolicy.create({data:{id:1,fingerprint}});
 for(const phase of ['reserved','started']){
  const c=await p.integrationClient.create({data:{code:'A6_CRASH_'+randomUUID(),name:'Synthetic crash'}});
  const child=fork(new URL(import.meta.url),['child',c.id,phase],{env:process.env,stdio:['ignore','ignore','ignore','ipc']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Child timeout'))},20000);child.once('message',()=>{clearTimeout(timer);resolve()});child.once('exit',()=>{clearTimeout(timer);reject(Error('Child exited before durable phase'))})});
  const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));child.kill('SIGKILL');const exit=await exited;
  const before=await p.prequoteConsumptionPermit.findMany({where:{integrationClientId:c.id}});assert.equal(before.length,1);assert.equal(before[0].state,phase==='reserved'?'RESERVED':'STARTED');
  await wait(1100);
  const next=await services[1].admit(c.id);assert(next.admitted);await next.permit.finish({routingStarted:false,published:false});
  const after=await p.prequoteConsumptionPermit.findUniqueOrThrow({where:{id:before[0].id}});
  assert.equal(after.state,phase==='reserved'?'EXPIRED':'STARTED');assert.equal(after.units,1);if(phase==='started')assert(after.protectedUntil>new Date());
  results.crashes.push({phase,exit,stateAfterRecovery:after.state,units:after.units,consumptionRetained:!!after.startedAt});
 }
 const clients=await Promise.all(Array.from({length:100},()=>p.integrationClient.create({data:{code:'A6_LOAD_'+randomUUID(),name:'Synthetic load'}})));
 const stages=[0,1000,5000];let added=0;
 for(const total of stages){
  for(let offset=added;offset<total;offset+=250){
   const count=Math.min(250,total-offset);const old=new Date(Date.now()-7*86400000);const current=new Date();
   const history=Array.from({length:count},(_,i)=>({id:randomUUID(),integrationClientId:clients[(offset+i)%clients.length].id,ownerHash:'0'.repeat(64),policyFingerprint:fingerprint,state:'RESERVED',units:1,routingBudgetMs:16000,reservedAt:old,reserveExpiresAt:new Date(old.getTime()+1000)}));
   const live=history.map(row=>({...row,id:randomUUID(),reservedAt:current,reserveExpiresAt:new Date(current.getTime()+300000)}));
   await p.prequoteConsumptionPermit.createMany({data:[...history,...live]});
   await p.prequoteConsumptionPermit.updateMany({where:{id:{in:history.map(r=>r.id)}},data:{state:'EXPIRED',finishedAt:current}});
   await p.prequoteConsumptionPermit.updateMany({where:{id:{in:live.map(r=>r.id)}},data:{state:'STARTED',startedAt:current,startBy:new Date(current.getTime()+5000),protectedUntil:new Date(current.getTime()+16000)}});
   await p.prequoteConsumptionPermit.updateMany({where:{id:{in:live.map(r=>r.id)}},data:{state:'FINISHED',finishedAt:new Date(),routingReported:true,publishedReported:false}});
  }
  added=total;
  for(const concurrency of [2,8]){
   const latencies=[],errors={};let success=0;let cursor=0;const started=performance.now();
   await Promise.all(Array.from({length:concurrency},async(_,worker)=>{while(cursor<100){const index=cursor++;const start=performance.now();try{const r=await services[worker%2].admit(clients[index%clients.length].id);latencies.push(performance.now()-start);if(r.admitted){success++;await r.permit.finish({routingStarted:false,published:false})}else errors.denied=(errors.denied||0)+1}catch(e){const code=e.code||'UNEXPECTED';errors[code]=(errors[code]||0)+1;latencies.push(performance.now()-start)}}}));
   const durationMs=performance.now()-started;latencies.sort((a,b)=>a-b);const q=pct=>Math.round(latencies[Math.ceil(pct*latencies.length)-1]*100)/100;
   const sample={historicalExpired:total,currentStarted:total,rows:await p.prequoteConsumptionPermit.count(),concurrency,requests:100,success,errors,durationMs:Math.round(durationMs),operationsPerSecond:Math.round(100000/durationMs*100)/100,admissionMs:{p50:q(.5),p95:q(.95),p99:q(.99)}};results.load.push(sample);console.log(JSON.stringify(sample));
  }
 }
 const plan=await p.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM "PrequoteConsumptionPermit" WHERE (state='RESERVED' AND "reserveExpiresAt">clock_timestamp() AT TIME ZONE 'UTC') OR "startedAt">(clock_timestamp() AT TIME ZONE 'UTC')-interval '24 hours' OR "protectedUntil">clock_timestamp() AT TIME ZONE 'UTC'`);
 results.queryPlan=plan;results.routingCalls=routingCalls;results.historyRetained=true;
 writeFileSync('docs/checks/v1.13-a6-load.json',JSON.stringify(results,null,2));
 }finally{for(const a of apps)await a.close();await p.$disconnect()}
}
