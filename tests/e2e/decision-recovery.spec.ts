import type {APIResponse,Locator,Page,Route} from '@playwright/test';
import type {Decision,DecisionAction,DecisionsResponse,WorkDetailResponse,WorkspaceResponse} from '@renvarel/architect-core';
import {test,expect,actionHeaders,createProject,post,type ExperienceFixtureEnvelope} from './fixtures';

let fixture:ExperienceFixtureEnvelope;

async function read<T>(page:Page,url:string):Promise<T> {
  const response=await page.request.get(url);expect(response.status()).toBe(200);
  return response.json() as Promise<T>;
}
async function queue(page:Page):Promise<Locator> {
  await page.locator('.topbar').getByRole('button',{name:/^Needs your decision\b/}).click();
  const region=page.getByRole('region',{name:'Decisions',exact:true});await expect(region).toBeVisible();return region;
}
async function select(page:Page,id:string,reason:string):Promise<Locator> {
  await page.getByRole('button',{name:`Open decision ${id}`,exact:true}).first().click();
  const detail=page.getByRole('region',{name:'Decision detail',exact:true});
  await expect(detail).toBeVisible();await detail.getByRole('textbox',{name:'Your reason (optional)',exact:true}).fill(reason);
  return detail;
}
async function decision(page:Page,id:string):Promise<Decision> {
  let afterSequence=0;
  for(let n=0;n<20;n++){
    const result=await read<DecisionsResponse>(page,`/api/decisions?limit=50&afterSequence=${afterSequence}`);
    const found=result.decisions.find(row=>row.id===id);if(found)return found;
    if(!result.page.hasMore)break;
    expect(result.page.nextAfterSequence).toBeGreaterThan(afterSequence);afterSequence=result.page.nextAfterSequence;
  }
  throw new Error('Expected populated synthetic Decision was not accessible.');
}
async function externalReject(page:Page,id:string,reason:string):Promise<Decision> {
  const before=await decision(page,id);
  expect(before.status).toBe('pending');
  const response=await page.request.post(`/api/decisions/${id}/action`,{headers:actionHeaders,data:{
    clientRequestId:crypto.randomUUID(),expectedVersion:before.version,proposalDigest:before.proposalDigest,action:'reject',reason,
  } satisfies DecisionAction});
  expect(response.status()).toBe(200);
  const result=(await response.json() as {decision:Decision}).decision;
  expect(result.status).toBe('rejected');expect(result.receipt).toMatchObject({action:'reject',reason,actor:'local-owner-session'});
  return result;
}
async function poll(page:Page,path='/api/decisions'):Promise<void> {
  const started=Date.now();
  const response=await page.waitForResponse(value=>value.request().method()==='GET'&&new URL(value.url()).pathname===path&&Date.now()-started>=5000,{timeout:15000});
  expect(response.status()).toBe(200);
}
function browserActions(page:Page):string[] {
  const actions:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/decisions\/[^/]+\/action$/.test(new URL(request.url()).pathname))actions.push(new URL(request.url()).pathname);});
  return actions;
}
async function holdReads(page:Page):Promise<()=>Promise<void>> {
  let release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const handler=async(route:Route):Promise<void>=>{if(route.request().method()==='GET')await gate;await route.continue().catch(()=>{});};
  const pattern='**/api/{workspace,decisions}*';await page.route(pattern,handler);
  return async()=>{release();await page.unroute(pattern,handler);};
}
async function holdResponse(page:Page,path:string,method:'GET'|'POST'):Promise<{
  ready:Promise<APIResponse>;release:()=>Promise<void>;
}> {
  let ready:(response:APIResponse)=>void=()=>{},fail:(reason:unknown)=>void=()=>{},unblock:()=>void=()=>{},done:()=>void=()=>{};
  const responseReady=new Promise<APIResponse>((resolve,reject)=>{ready=resolve;fail=reject;});
  const gate=new Promise<void>(resolve=>{unblock=resolve;}),finished=new Promise<void>(resolve=>{done=resolve;});
  let captured=false;
  const handler=async(route:Route):Promise<void>=>{
    if(captured||route.request().method()!==method){await route.continue();return;}
    captured=true;
    try{const response=await route.fetch();ready(response);await gate;await route.fulfill({response}).catch(()=>{});}
    catch(reason){fail(reason);await route.abort().catch(()=>{});}finally{done();}
  };
  const pattern=`**${path}`;await page.route(pattern,handler);
  return {ready:responseReady,release:async()=>{unblock();await page.unroute(pattern,handler);if(captured)await finished;}};
}
async function conflictAfterExternalReject(page:Page,id:string):Promise<Decision> {
  const rejected=await externalReject(page,id,'Another fictional owner tab rejected this exact request.');
  const response=page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname===`/api/decisions/${id}/action`);
  await page.getByRole('region',{name:'Decision detail',exact:true}).getByRole('button',{name:'Approve this action',exact:true}).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole('button',{name:'Refresh request',exact:true})).toBeVisible();return rejected;
}
async function projectScopeB(page:Page,reason:string):Promise<Locator> {
  await page.getByRole('button',{name:'Decisions',exact:true}).click();
  const response=await read<DecisionsResponse>(page,`/api/decisions?projectId=${fixture.project.id}&state=pending&limit=50`);
  expect(response.decisions.some(row=>row.id===fixture.decisionIds.requestRevision)).toBe(true);
  return select(page,fixture.decisionIds.requestRevision,reason);
}

test.beforeEach(async({page,servers})=>{
  fixture=await servers.startExperience();
  const first=await read<DecisionsResponse>(page,'/api/decisions?state=pending&limit=50');
  expect(first.total).toBe(125);expect(first.decisions).toHaveLength(50);
  expect(first.decisions.some(row=>row.id===fixture.decisionIds.approve)).toBe(true);
  expect((await read<WorkDetailResponse>(page,`/api/work/${fixture.workIds.verified}`)).verification).toBe('verified');
  expect((await page.request.get('/api/local-session')).status()).toBe(200);
  expect((await page.context().cookies()).some(value=>value.name==='sovrad_local_action'&&value.httpOnly)).toBe(true);
  await page.goto('/');await queue(page);
});

test('polling reconciles an externally resolved selected request without mistaking an off-page pending request for a terminal one',async({page,servers})=>{
  const region=page.getByRole('region',{name:'Decisions',exact:true});
  await region.getByRole('button',{name:'Load more',exact:true}).click();await expect(region).toContainText('Showing 100 of 125');
  await region.getByRole('button',{name:'Load more',exact:true}).click();await expect(region).toContainText('Showing 125 of 125');
  const olderReason='  Keep this older pending request draft.  ';
  let detail=await select(page,fixture.decisionIds.lastPending,olderReason);
  expect((await decision(page,fixture.decisionIds.lastPending)).status).toBe('pending');
  const actions=browserActions(page);
  await servers.experienceChange({kind:'resolve_pending_and_replace'});await poll(page);
  await expect(region).toContainText('Showing 50 of 125');
  expect((await read<DecisionsResponse>(page,'/api/decisions?state=pending&limit=50')).decisions.some(row=>row.id===fixture.decisionIds.lastPending)).toBe(false);
  expect((await decision(page,fixture.decisionIds.lastPending)).status).toBe('pending');
  await expect(detail.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue(olderReason);
  for(const name of ['Approve this action','Reject','Request revision'])await expect(detail.getByRole('button',{name,exact:true})).toBeEnabled();
  const reason='  Keep my exact reason after another tab resolves A.\nسطر محفوظ  ';
  detail=await select(page,fixture.decisionIds.approve,reason);
  const resolved=await externalReject(page,fixture.decisionIds.approve,'Externally reviewed and rejected.');
  await poll(page);
  await expect(detail.locator('.decision-state')).toHaveText('rejected',{timeout:15000});
  await expect(detail.getByRole('region',{name:'Decision outcome',exact:true})).toContainText(resolved.receipt!.reason);
  await expect(detail.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue(reason);
  for(const name of ['Approve this action','Reject','Request revision'])await expect(detail.getByRole('button',{name,exact:true})).toBeDisabled();
  expect((await decision(page,fixture.decisionIds.requestRevision)).status).toBe('pending');expect(actions).toHaveLength(0);
});

test('a delayed genuine explicit refresh of A cannot replace newer B selection, scope or exact reason',async({page})=>{
  const a=await decision(page,fixture.decisionIds.approve),b=await decision(page,fixture.decisionIds.requestRevision);
  await select(page,a.id,'Keep the old A draft.');
  const releaseReads=await holdReads(page);
  let held:Awaited<ReturnType<typeof holdResponse>>|undefined;
  const actions=browserActions(page);
  try{
    const rejected=await conflictAfterExternalReject(page,a.id);
    held=await holdResponse(page,`/api/work/${a.workId}`,'GET');
    await page.getByRole('button',{name:'Refresh request',exact:true}).click();
    const actual=await held.ready;expect(actual.status()).toBe(200);
    expect((await actual.json() as WorkDetailResponse).decisions.find(row=>row.id===a.id)?.receipt).toEqual(rejected.receipt);
    await select(page,b.id,'First B selection while A is delayed.');
    await releaseReads();
    const reason='  Keep B in the project scope.\nDo not restore A.  ';
    const detail=await projectScopeB(page,reason);
    const lateScopes:string[]=[];
    page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname==='/api/decisions')lateScopes.push(new URL(request.url()).searchParams.get('projectId')??'GLOBAL');});
    await held.release();held=undefined;
    await poll(page);
    await expect(detail.getByRole('region',{name:'Decision explanation',exact:true})).toContainText(b.explanation.action);
    await expect(detail.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue(reason);
    expect(lateScopes.length).toBeGreaterThan(0);expect(lateScopes.every(scope=>scope===fixture.project.id)).toBe(true);
    expect((await decision(page,b.id)).status).toBe('pending');expect(actions).toEqual([`/api/decisions/${a.id}/action`]);
  }finally{await releaseReads();await held?.release();}
});

test('a late real approval response updates A history and counts without replacing newer B or approving it',async({page})=>{
  const a=await decision(page,fixture.decisionIds.approve),b=await decision(page,fixture.decisionIds.requestRevision);
  const reasonA='  Approve A only, retaining these bytes.  ';
  await select(page,a.id,reasonA);
  const held=await holdResponse(page,`/api/decisions/${a.id}/action`,'POST'),actions=browserActions(page);
  try{
    await page.getByRole('region',{name:'Decision detail',exact:true}).getByRole('button',{name:'Approve this action',exact:true}).click();
    const actual=await held.ready;expect(actual.status()).toBe(200);
    const approved=(await actual.json() as {decision:Decision}).decision;
    expect(approved.receipt).toMatchObject({action:'approve',reason:reasonA,actor:'local-owner-session'});
    expect((await read<WorkspaceResponse>(page,'/api/workspace')).pendingDecisionCount).toBe(124);
    expect((await decision(page,a.id)).receipt).toEqual(approved.receipt);
    await select(page,b.id,'B remains a separate pending choice.');
    const reasonB='  B must stay selected after A completes.  ';
    const detail=await projectScopeB(page,reasonB);
    const lateScopes:string[]=[];
    page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname==='/api/decisions')lateScopes.push(new URL(request.url()).searchParams.get('projectId')??'GLOBAL');});
    await held.release();await poll(page);
    await expect(detail.getByRole('region',{name:'Decision explanation',exact:true})).toContainText(b.explanation.action);
    await expect(detail.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue(reasonB);
    for(const name of ['Approve this action','Reject','Request revision'])await expect(detail.getByRole('button',{name,exact:true})).toBeEnabled();
    expect(lateScopes.every(scope=>scope===fixture.project.id)).toBe(true);
    expect((await decision(page,b.id)).status).toBe('pending');expect(actions).toEqual([`/api/decisions/${a.id}/action`]);
    expect((await read<WorkspaceResponse>(page,'/api/workspace')).pendingDecisionCount).toBe(124);
  }finally{await held.release();}
});

test('a real selected-record404 and successful global queue omission purge only inaccessible project detail and drafts across access restoration',async({page})=>{
  await post(page.request,'/api/workspace/access',{mode:'all_connected',selectedProjectIds:[]});
  const q=await createProject(page.request,'Fictional continuously accessible recovery project');
  const a=await decision(page,fixture.decisionIds.approve),privateReason='  Fictional P-only reason that must be purged.\nRetain no hidden draft.  ';
  const detail=await select(page,a.id,privateReason);
  await expect(detail.getByRole('region',{name:'Decision explanation',exact:true})).toContainText(a.explanation.action);
  await expect(detail.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue(privateReason);
  expect((await read<WorkspaceResponse>(page,'/api/workspace')).projects.some(value=>value.id===fixture.project.id)).toBe(true);
  const qBefore=await read<{project:{id:string;name:string}}>(page,`/api/projects/${q.id}/overview`);
  expect(qBefore.project.name).toBe(q.name);
  const releaseReads=await holdReads(page),actions=browserActions(page);
  try{
    await conflictAfterExternalReject(page,a.id);
    const populated=await read<DecisionsResponse>(page,'/api/decisions?state=pending&limit=50');
    expect(populated.total).toBe(124);expect(populated.decisions.some(row=>row.projectId===fixture.project.id)).toBe(true);
    await post(page.request,'/api/workspace/access',{mode:'selected',selectedProjectIds:[q.id]});
    const global=await read<DecisionsResponse>(page,'/api/decisions?state=pending&limit=50');
    expect(global.total).toBe(0);expect(global.decisions).toEqual([]);
    const lookup=await page.request.get(`/api/work/${a.workId}`);expect(lookup.status()).toBe(404);
    expect((await read<{project:{id:string;name:string}}>(page,`/api/projects/${q.id}/overview`)).project).toMatchObject(qBefore.project);
    const denied=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname===`/api/work/${a.workId}`&&response.status()===404);
    await page.getByRole('button',{name:'Refresh request',exact:true}).click();await denied;
    await expect(page.getByRole('region',{name:'Decision detail',exact:true})).toHaveCount(0);
    await expect(page.getByText(a.explanation.action,{exact:true})).toHaveCount(0);
    expect(await page.locator('textarea').evaluateAll(rows=>rows.some(row=>row.value.includes('Fictional P-only reason')))).toBe(false);
    await releaseReads();await poll(page,'/api/workspace');
    const visible=await read<WorkspaceResponse>(page,'/api/workspace');expect(visible.projects.map(value=>value.id)).toEqual([q.id]);
    await expect(page.locator('.sidebar').getByRole('button',{name:q.name,exact:true})).toBeVisible();
    await post(page.request,'/api/workspace/access',{mode:'all_connected',selectedProjectIds:[]});await poll(page,'/api/workspace');
    await expect(page.getByRole('region',{name:'Decision detail',exact:true})).toHaveCount(0);
    expect(await page.locator('textarea').evaluateAll(rows=>rows.some(row=>row.value.includes('Fictional P-only reason')))).toBe(false);
    await page.locator('.sidebar').getByRole('button',{name:fixture.project.name,exact:true}).click();
    await page.getByRole('button',{name:'Work & results',exact:true}).click();
    await page.getByRole('button',{name:`Open work ${a.workId}`,exact:true}).click();
    await page.getByRole('region',{name:'Work detail',exact:true}).getByRole('button',{name:`Open decision ${a.id}`,exact:true}).click();
    const reopened=page.getByRole('region',{name:'Decision detail',exact:true});
    await expect(reopened.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue('');
    await expect(reopened.locator('.decision-state')).toHaveText('rejected');
    expect((await read<{project:{id:string;name:string}}>(page,`/api/projects/${q.id}/overview`)).project).toMatchObject(qBefore.project);
    expect(actions).toEqual([`/api/decisions/${a.id}/action`]);
  }finally{await releaseReads();}
});
