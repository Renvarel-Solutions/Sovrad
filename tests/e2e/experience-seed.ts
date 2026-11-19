import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import type {Storage} from '../../apps/api/src/storage.js';
import type {RuntimeAuthority} from '../../apps/api/src/execution-binding-store.js';
import type {ExperienceFixtureEnvelope} from './experience-contract.js';
// Shared metadata-only helper is frozen production-review input; this adapter
// supplies the explicitly selected scratch server's local headers to its injects.
import {bootstrap,approveSpec,work,installAuthority,decisionInput,explanation,running,evidence,passes,complete} from '../../apps/api/src/experience-fixture.mjs';

export type SeedContext={storage:Storage;db:Database.Database;facts:Map<string,RuntimeAuthority>;app:{inject:(input:unknown)=>ReturnType<FastifyInstance['inject']>};
  cookie:string|null;session:unknown;readonly now:number};
export function seedContext(storage:Storage,db:Database.Database,facts:Map<string,RuntimeAuthority>,app:FastifyInstance,port:number,webPort:number):SeedContext {
  return {storage,db,facts,cookie:null,session:null,get now(){return Date.now();},app:{inject:(input:unknown)=>{
    const request=input as {headers?:Record<string,string>};
    return app.inject({...request,headers:{...request.headers,host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${webPort}`}});
  }}};
}

export async function seedExperience(f:SeedContext):Promise<ExperienceFixtureEnvelope> {
  await bootstrap(f);approveSpec(f);
  const project=f.storage.registry.project('sample-calculator'),workflow=f.storage.workflow('sample-calculator-arithmetic')!;
  const implemented=f.storage.registry.saveItem(project.id,{clientRequestId:crypto.randomUUID(),expectedMapRevision:project.mapRevision,parentId:null,kind:'feature',
    name:'Fictional implemented item without tests',description:'Implementation metadata alone is not verification.',development:'implemented',workflowId:null}).item;
  const context=(stepId:string)=>({projectId:project.id,workflowId:workflow.id,stepId,specRevision:workflow.revision,mapRevision:f.storage.registry.project(project.id).mapRevision});
  const verified=await running(f,{overrides:{context:context('number-a'),text:'Keep this exact fictional instruction.\nVerify finite operands before completion.'}});passes(f,verified);complete(f,verified);
  const verifiedControl=await running(f,{overrides:{context:context('result'),text:'A separate independently bound verified result.'}});passes(f,verifiedControl);complete(f,verifiedControl);
  const failed=await running(f,{overrides:{context:context('number-b'),text:'A fictional acceptance check that fails.'}});passes(f,failed);evidence(f,failed,failed.binding.acceptanceSnapshot[0].id,{outcome:'failed',summary:'The fictional nonfinite operand acceptance check failed.'});complete(f,failed);
  const failedCompletion=await running(f,{overrides:{context:context('number-b'),text:'Passing tests cannot repair failed runtime completion.'}});passes(f,failedCompletion);complete(f,failedCompletion,'failed');
  const checking=await running(f,{overrides:{context:context('operator'),text:'Completion without acceptance remains Checking.'}});complete(f,checking);
  const historical=await running(f,{overrides:{context:context('calculate'),text:'The old fictional source authority changed.'}});passes(f,historical);complete(f,historical);
  f.facts.get(historical.work.id)!.sourceRevision='b'.repeat(40);f.storage.work.get(historical.work.id);
  const stale=await work(f,{context:context('calculate'),text:'A pending bounded runtime request used for a real stale action.'});installAuthority(f,stale.work);
  const staleDecision=f.storage.decisions.create(decisionInput(f,stale.work));
  const decisions:Record<string,string>={stale:staleDecision.id};
  for(const [key,stepId] of [['approve','number-a'],['reject','number-b'],['requestRevision','operator']]){
    const saved=await work(f,{context:context(stepId),intent:'question',text:`A fictional owner ${key} review.`,dispatch:{mode:'local',consent:false}},null);
    const value=decisionInput(f,saved.work),details=explanation();
    details.action=`Review the fictional ${key} request.`;
    details.cost.ongoingMicros=key==='approve'?null:0;
    decisions[key]=f.storage.decisions.create({...value,explanation:details}).id;
  }
  for(let n=4;n<125;n++)decisions.lastPending=f.storage.decisions.create(decisionInput(f,null,{explanation:{...explanation(),action:`Review fictional pending request ${n+1}.`}})).id;
  const projectContext={projectId:project.id,mapRevision:f.storage.registry.project(project.id).mapRevision};
  const connectionCodex=await work(f,{context:projectContext,intent:'question',target:'codex',text:'A pending fictional Codex discussion.'},null);
  const connectionChatgpt=await work(f,{context:projectContext,intent:'question',target:'chatgpt',text:'A separate pending fictional ChatGPT discussion.'},null);
  const connectionAutomatic=await work(f,{context:projectContext,intent:'question',target:'automatic',text:'A pending automatically targeted fictional discussion.'},null);
  // Seed the sole active attempt last. A real five-second heartbeat preserves
  // its bounded lease; no timer advances its Work state or fabricates evidence.
  const activePasses=await running(f,{overrides:{context:context('operator'),text:'All passes are present but runtime completion is unconfirmed.'}});passes(f,activePasses);
  const records={verified,verifiedControl,failed,checking,activePasses,failedCompletion,historical,stale,connectionCodex,connectionChatgpt,connectionAutomatic};
  return {project:{id:project.id,name:project.name},workflow:{id:workflow.id,name:workflow.name},pendingTotal:f.storage.decisions.list({state:'pending'}).total,
    decisionIds:decisions as ExperienceFixtureEnvelope['decisionIds'],workIds:Object.fromEntries(Object.entries(records).map(([key,value])=>[key,value.work.id])) as ExperienceFixtureEnvelope['workIds'],
    itemIds:{implemented:implemented.id},stepIds:{verified:'number-a',verifiedControl:'result',failed:'number-b',checking:'operator',historical:'calculate',implemented:null},
    contexts:Object.fromEntries(Object.entries(records).map(([key,value])=>[key,value.work.context])),
    annotationOriginal:{text:verified.annotation.text,materialJSON:verified.annotation.materialJSON}};
}
