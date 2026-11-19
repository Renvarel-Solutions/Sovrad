// Dedicated synthetic browser-test entrypoint. Normal server.ts has no adapter,
// fixture flag, command endpoint or access to this private IPC channel.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {z} from 'zod';
import {Storage} from '../../apps/api/src/storage.js';
import {buildApp} from '../../apps/api/src/server.js';
import {validateDataDirectory} from '../../apps/api/src/data-directory.js';
import type {RuntimeAuthority} from '../../apps/api/src/execution-binding-store.js';
import type {LocalActionSession} from '@renvarel/architect-core';
import {bootstrap,decisionInput} from '../../apps/api/src/experience-fixture.mjs';
import {seedContext,seedExperience} from './experience-seed.js';
import type {ExperienceCommand,ExperienceCommandResult,ExperienceFixtureEnvelope,ExperienceIPCResponse} from './experience-contract.js';

const commandSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('snapshot')}).strict(),z.object({kind:z.literal('resolve_pending_and_replace')}).strict(),
  z.object({kind:z.literal('invalidate_source'),workId:z.string().uuid()}).strict(),
]);
const requestSchema=z.object({id:z.string().uuid(),command:commandSchema}).strict();

async function start():Promise<void> {
  if(!process.send)throw new Error('The owned fixture IPC channel is required.');
  const directory=validateDataDirectory(process.env.SOVRAD_DATA_DIR??'');
  const factsFile=path.join(directory,'experience-authority.json'),receiptFile=path.join(directory,'experience-fixture.json');
  const facts=new Map<string,RuntimeAuthority>(existsSync(factsFile)?JSON.parse(readFileSync(factsFile,'utf8')):[]);
  const storage=new Storage(directory,{now:()=>Date.now(),authority:{current:work=>structuredClone(facts.get(work.id)??null)}});
  const port=Number(process.env.API_PORT??4319),webPort=Number(process.env.WEB_PORT??5175);
  const app=buildApp(storage,{port,webPort,ai:{enabled:false}}),db=new Database(path.join(directory,'sovrad.sqlite'));
  const f=seedContext(storage,db,facts,app,port,webPort);
  const persistFacts=():void=>{writeFileSync(factsFile,JSON.stringify([...facts]),{encoding:'utf8',mode:0o600});};
  let fixture:ExperienceFixtureEnvelope;
  if(existsSync(receiptFile)){fixture=JSON.parse(readFileSync(receiptFile,'utf8'));await bootstrap(f);}
  else {fixture=await seedExperience(f);persistFacts();writeFileSync(receiptFile,JSON.stringify(fixture),{encoding:'utf8',mode:0o600});}
  const protectedIds=new Set(Object.values(fixture.decisionIds));
  const command=(input:ExperienceCommand):ExperienceCommandResult=>{
    if(input.kind==='snapshot')return storage.experienceRead(()=>({kind:'snapshot',fixture,
      workspace:storage.registry.workspace(),decisions:storage.decisions.list({state:'pending',limit:100}),
      work:[...new Set(Object.values(fixture.workIds))].map(id=>storage.work.detail(id))}));
    if(input.kind==='invalidate_source'){
      const value=facts.get(input.workId);if(!value)throw new Error('Unknown synthetic authority.');
      value.sourceRevision=createHash('sha256').update(value.sourceRevision+' fixture invalidation').digest('hex');
      persistFacts();const detail=storage.work.detail(input.workId);
      return {kind:input.kind,workId:input.workId,workState:detail.work.state,verification:detail.verification};
    }
    const old=storage.decisions.pending().find(d=>d.workId===null&&!protectedIds.has(d.id));
    if(!old)throw new Error('No replaceable synthetic pending request.');
    storage.decisions.resolve(old.id,{clientRequestId:crypto.randomUUID(),expectedVersion:old.version,proposalDigest:old.proposalDigest,action:'reject',reason:'The synthetic queue membership changed.'},f.session as LocalActionSession);
    const replacement=storage.decisions.create(decisionInput(f));
    const page=storage.decisions.list({state:'pending'});
    return {kind:input.kind,removedDecisionId:old.id,replacementDecisionId:replacement.id,pendingTotal:page.total,viewDigest:page.page.viewDigest};
  };
  process.on('message',message=>{
    const parsed=requestSchema.safeParse(message);if(!parsed.success)return;
    let response:ExperienceIPCResponse;
    try{response={id:parsed.data.id,ok:true,result:command(parsed.data.command)};}
    catch{response={id:parsed.data.id,ok:false,error:'The synthetic fixture operation was refused.'};}
    if(process.connected)process.send!(response);
  });
  const heartbeat=setInterval(()=>{
    const binding=storage.executionBindings.current(fixture.workIds.activePasses);
    if(binding)try{storage.executionBindings.heartbeat({executionBindingId:binding.id,attemptId:binding.attemptId,leaseFence:binding.leaseFence});}catch{/* Expired/revoked attempts never resume. */}
  },5_000);
  let closing=false;
  const close=async():Promise<void>=>{
    if(closing)return;closing=true;clearInterval(heartbeat);db.close();await app.close();if(process.connected)process.disconnect();
  };
  process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});process.once('disconnect',()=>{void close();});
  await app.listen({port,host:'127.0.0.1'});
  console.log('Synthetic experience fixture is ready.');
}
void start().catch(()=>{console.error('Synthetic experience fixture could not start.');process.exit(1);});
