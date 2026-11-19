import type {Locator, Page} from '@playwright/test';
import type {OverviewResponse, StepVerification, WorkDetailResponse, WorkflowDetailResponse, WorkspaceResponse} from '@renvarel/architect-core';
import {test, expect, type ExperienceFixtureEnvelope} from './fixtures';

let fixture:ExperienceFixtureEnvelope;
const labels:Record<StepVerification['verification'],string>={not_checked:'Not yet checked',checking:'Checking',verified:'Verified',failed:'Check failed',stale:'Previous check is stale'};

async function read<T>(page:Page,url:string):Promise<T> {
  const response=await page.request.get(url);expect(response.status()).toBe(200);
  return response.json() as Promise<T>;
}

async function selectProject(page:Page):Promise<void> {
  await page.locator('.sidebar').getByRole('button',{name:fixture.project.name,exact:true}).click();
  await expect(page.getByRole('heading',{name:fixture.project.name,exact:true})).toBeVisible();
}

async function openWorkflow(page:Page):Promise<void> {
  await selectProject(page);
  await page.getByRole('button',{name:`Open ${fixture.workflow.name}`,exact:true}).click();
  await expect(page.getByRole('complementary',{name:'Stage inspector',exact:true})).toBeVisible();
}

async function showWork(page:Page,id:string):Promise<Locator> {
  await page.getByRole('button',{name:'Work & results',exact:true}).click();
  await page.getByRole('button',{name:`Open work ${id}`,exact:true}).click();
  const detail=page.getByRole('region',{name:'Work detail',exact:true});
  await expect(detail).toBeVisible();return detail;
}

async function assertOriginal(region:Locator,detail:WorkDetailResponse):Promise<void> {
  expect(await region.locator('.annotation-original').textContent()).toBe(detail.annotation.text);
  const material=region.getByRole('region',{name:'Selected material',exact:true});
  await material.getByText('Exact selected JSON',{exact:true}).click();
  const shown=await material.locator('pre').textContent();
  expect(JSON.parse(shown!)).toEqual(JSON.parse(detail.annotation.materialJSON));
}

test.beforeEach(async({page,servers})=>{
  fixture=await servers.startExperience();
  const snapshot=await servers.experienceChange({kind:'snapshot'});
  expect(snapshot.workspace.pendingDecisionCount).toBe(125);
  expect(snapshot.work.find(value=>value.work.id===fixture.workIds.verified)?.verification).toBe('verified');
  expect(snapshot.work.find(value=>value.work.id===fixture.workIds.verifiedControl)?.verification).toBe('verified');
  expect(snapshot.work.find(value=>value.work.id===fixture.workIds.failed)?.verification).toBe('failed');
  expect(snapshot.work.find(value=>value.work.id===fixture.workIds.checking)).toMatchObject({verification:'not_checked',work:{state:'checking'}});
  expect(snapshot.work.find(value=>value.work.id===fixture.workIds.activePasses)?.verification).toBe('checking');
  expect(snapshot.work.find(value=>value.work.id===fixture.workIds.failedCompletion)?.verification).toBe('failed');
  const workspace=await read<WorkspaceResponse>(page,'/api/workspace');
  expect(workspace.pendingDecisionCount).toBe(125);
  for(const row of snapshot.work){
    const served=await read<WorkDetailResponse>(page,`/api/work/${row.work.id}`);
    expect(served.verification).toBe(row.verification);expect(served.work.state).toBe(row.work.state);
  }
  await page.goto('/');
});

test('workspace, project, graph, accessible list and Work detail display the same server-derived evidence',async({page})=>{
  const workflow=await read<WorkflowDetailResponse>(page,`/api/workflows/${fixture.workflow.id}`);
  const overview=await read<OverviewResponse>(page,`/api/projects/${fixture.project.id}/overview`);
  const projected=overview.workflows.find(value=>value.id===fixture.workflow.id)!.stepVerification;
  expect(projected).toEqual(workflow.stepVerification);
  expect(workflow.stepVerification.map(value=>[value.stepId,value.verification]).sort()).toEqual([
    ['number-a','verified'],['number-b','failed'],['operator','checking'],['calculate','stale'],['result','verified'],
  ].sort());
  const workspace=await read<WorkspaceResponse>(page,'/api/workspace');
  const allWork=await read<{work:WorkDetailResponse['work'][]}>(page,`/api/work?projectId=${fixture.project.id}&limit=100`);
  expect(allWork.work.length).toBeLessThan(100);
  for(const [state,count] of Object.entries(workspace.counts))expect(allWork.work.filter(value=>value.state===state)).toHaveLength(count);
  await page.locator('.sidebar').getByRole('button',{name:'Workspace',exact:true}).click();
  const summary=page.getByRole('region',{name:'Work summary',exact:true});
  for(const [state,count] of Object.entries(workspace.counts)){
    await expect(summary.locator(`[data-work-state="${state}"]`)).toHaveText(new RegExp(`(^|\\D)${count}$`));
  }
  await selectProject(page);
  const implemented=page.locator(`[data-item-id="${fixture.itemIds.implemented}"]`);
  await expect(implemented).toContainText('Implemented');
  await expect(implemented).toContainText('Map not linked');
  await expect(implemented).not.toContainText('Verified');
  const totals=page.getByRole('region',{name:'Verification summary',exact:true});
  for(const [status,count] of Object.entries(overview.totals.verificationCounts)){
    await expect(totals.locator(`[data-verification="${status}"]`)).toHaveText(new RegExp(`(^|\\D)${count}$`));
  }
  await openWorkflow(page);
  for(const step of workflow.stepVerification){
    const node=page.locator(`.react-flow__node[data-id="${step.stepId}"]`);
    await expect(node.locator('.verification-badge')).toHaveText(labels[step.verification]);
    await node.click();
    await expect(page.getByRole('complementary',{name:'Stage inspector',exact:true})).toContainText(step.reason);
  }
  await page.getByRole('button',{name:'List view',exact:true}).click();
  for(const step of workflow.workflow.steps){
    const expected=workflow.stepVerification.find(value=>value.stepId===step.id)!;
    const row=page.getByRole('button',{name:`Select ${step.title}`,exact:true});
    await expect(row).toContainText(labels[expected.verification]);await row.click();
    await expect(page.getByRole('complementary',{name:'Stage inspector',exact:true})).toContainText(expected.reason);
  }
  const cases:[string,StepVerification['verification'],string][]=[
    [fixture.workIds.verified,'verified','Done'],[fixture.workIds.verifiedControl,'verified','Done'],
    [fixture.workIds.failed,'failed','Blocked'],[fixture.workIds.failedCompletion,'failed','Blocked'],
    [fixture.workIds.checking,'not_checked','Checking'],[fixture.workIds.activePasses,'checking','Working'],
    [fixture.workIds.historical,'stale','Blocked'],
  ];
  for(const [id,verification,state] of cases){
    const api=await read<WorkDetailResponse>(page,`/api/work/${id}`);
    expect(api.verification).toBe(verification);expect(api.work.state.toLowerCase()).toBe(state.toLowerCase());
    const detail=await showWork(page,id);
    await expect(detail.locator('.overview-heading')).toContainText(state);
    await expect(detail.getByRole('region',{name:'Evidence',exact:true})).toContainText(labels[verification]);
    const deployment=detail.getByRole('region',{name:'Deployment',exact:true});
    await expect(deployment).toContainText('Not observed');
    for(const evidence of api.evidence){
      const panel=detail.getByRole('region',{name:'Evidence',exact:true});
      await expect(panel).toContainText(evidence.summary);await expect(panel).toContainText(evidence.environment);
      await expect(panel).toContainText(evidence.freshness);
      if(evidence.sourceClass==='test_runtime')await expect(panel).toContainText(/test.*runtime/i);
      await expect(panel.locator(`time[datetime="${evidence.checkedAt}"]`).first()).toBeVisible();
      if(evidence.staleReason)await expect(panel).toContainText(evidence.staleReason);
    }
    if(verification!=='verified')await expect(detail.getByRole('region',{name:'Evidence',exact:true}).getByText('Verified',{exact:true})).toHaveCount(0);
  }
});

test('a genuinely verified result becomes historical everywhere while its immutable instruction and independent control survive',async({page,servers})=>{
  const before=await read<WorkDetailResponse>(page,`/api/work/${fixture.workIds.verified}`);
  expect(before.work.state).toBe('done');expect(before.verification).toBe('verified');
  expect(before.evidence.length).toBeGreaterThan(0);expect(before.evidence.every(value=>value.freshness==='current')).toBe(true);
  expect(before.annotation.text).toBe(fixture.annotationOriginal.text);expect(before.annotation.materialJSON).toBe(fixture.annotationOriginal.materialJSON);
  await selectProject(page);
  const region=await showWork(page,fixture.workIds.verified);
  await expect(region.getByRole('region',{name:'Evidence',exact:true})).toContainText('Verified');
  await assertOriginal(region,before);
  await servers.experienceChange({kind:'invalidate_source',workId:fixture.workIds.verified});
  const after=await read<WorkDetailResponse>(page,`/api/work/${fixture.workIds.verified}`);
  expect(after.work.state).toBe('blocked');expect(after.verification).toBe('stale');
  expect(after.annotation).toEqual(before.annotation);
  expect(after.evidence.map(value=>value.id)).toEqual(before.evidence.map(value=>value.id));
  expect(after.evidence.every(value=>value.freshness==='historical'&&!!value.staleReason)).toBe(true);
  await expect(region.getByRole('region',{name:'Evidence',exact:true})).toContainText('Previous check is stale',{timeout:15000});
  await expect(region.locator('.overview-heading')).toContainText('Blocked');
  expect(await region.locator('.annotation-original').textContent()).toBe(before.annotation.text);
  const control=await read<WorkDetailResponse>(page,`/api/work/${fixture.workIds.verifiedControl}`);
  expect(control.verification).toBe('verified');expect(control.work.state).toBe('done');
  await openWorkflow(page);
  await expect(page.locator(`.react-flow__node[data-id="${fixture.stepIds.verified}"]`)).toContainText('Previous check is stale');
  await expect(page.locator(`.react-flow__node[data-id="${fixture.stepIds.verifiedControl}"]`)).toContainText('Verified');
  await page.getByRole('button',{name:'List view',exact:true}).click();
  const workflow=await read<WorkflowDetailResponse>(page,`/api/workflows/${fixture.workflow.id}`);
  for(const id of [fixture.stepIds.verified,fixture.stepIds.verifiedControl]){
    const node=workflow.workflow.steps.find(value=>value.id===id)!;
    await expect(page.getByRole('button',{name:`Select ${node.title}`,exact:true})).toContainText(labels[workflow.stepVerification.find(value=>value.stepId===id)!.verification]);
  }
  const overview=await read<OverviewResponse>(page,`/api/projects/${fixture.project.id}/overview`);
  expect(overview.workflows.find(value=>value.id===fixture.workflow.id)!.stepVerification).toEqual(workflow.stepVerification);
  const workspace=await read<WorkspaceResponse>(page,'/api/workspace');
  expect(workspace.counts.done).toBe(1);
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  const totals=page.getByRole('region',{name:'Verification summary',exact:true});
  await expect(totals.locator('[data-verification="verified"]')).toHaveText(/(^|\D)1$/);
  const selected=await showWork(page,fixture.workIds.verified);
  await assertOriginal(selected,after);
  await page.reload();
  expect((await read<WorkDetailResponse>(page,`/api/work/${fixture.workIds.verified}`)).verification).toBe('stale');
  expect((await read<WorkDetailResponse>(page,`/api/work/${fixture.workIds.verifiedControl}`)).verification).toBe('verified');
});

test('real five-second polls preserve selected Work and unsent amendment and Decision reason drafts',async({page})=>{
  await selectProject(page);
  const source=await read<WorkDetailResponse>(page,`/api/work/${fixture.workIds.checking}`);
  const detail=await showWork(page,source.work.id);
  await detail.getByRole('button',{name:'Amend instruction',exact:true}).click();
  const composer=page.getByRole('dialog',{name:/Amend/});
  const text='  Preserve my unsent amendment.\nسطر خاص بالمثال  ';
  await composer.getByRole('textbox',{name:'Annotation text',exact:true}).fill(text);
  await composer.getByRole('combobox',{name:'Target',exact:true}).selectOption('chatgpt');
  await composer.getByRole('combobox',{name:'Intent',exact:true}).selectOption('question');
  const mutations:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/(annotations|work\/[^/]+\/amend|decisions\/[^/]+\/action)$/.test(new URL(request.url()).pathname))mutations.push(request.url());});
  const workObservedAt=Date.now();
  const workPoll=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname===`/api/work/${source.work.id}`&&Date.now()-workObservedAt>=5000,{timeout:15000});
  await workPoll;
  await expect(composer.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(text);
  await expect(composer.getByRole('combobox',{name:'Target',exact:true})).toHaveValue('chatgpt');
  await expect(composer.getByRole('combobox',{name:'Intent',exact:true})).toHaveValue('question');
  expect(await detail.locator('.annotation-original').textContent()).toBe(source.annotation.text);
  expect((await read<WorkDetailResponse>(page,`/api/work/${source.work.id}`)).annotation).toEqual(source.annotation);
  await composer.getByRole('button',{name:'Close',exact:true}).click();
  await expect(detail).toBeVisible();
  await expect(page.getByRole('button',{name:`Open work ${source.work.id}`,exact:true})).toBeVisible();
  await page.locator('.topbar').getByRole('button',{name:/^Needs your decision\b/}).click();
  await page.getByRole('button',{name:`Open decision ${fixture.decisionIds.reject}`,exact:true}).click();
  const decision=page.getByRole('region',{name:'Decision detail',exact:true});
  const reason='  Keep this unsent optional reason across polling.  ';
  await decision.getByRole('textbox',{name:'Your reason (optional)',exact:true}).fill(reason);
  const decisionObservedAt=Date.now();
  const decisionPoll=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/decisions'&&Date.now()-decisionObservedAt>=5000,{timeout:15000});
  await decisionPoll;
  await expect(decision.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue(reason);
  await expect(decision).toContainText('Review the fictional reject request.');
  expect(mutations).toHaveLength(0);
  expect((await read<WorkDetailResponse>(page,`/api/work/${source.work.id}`)).verification).toBe('not_checked');
});

test('Work view keeps unique project identities and immutable evidence across refreshes without console errors',async({page})=>{
  const errors:string[]=[];
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('pageerror',error=>errors.push(`pageerror: ${error.message}`));
  // Reload under observation before any Work navigation. Setup opens only the
  // initial workflow; warnings from this journey are never filtered or muted.
  await page.goto('/');
  const workspace=await read<WorkspaceResponse>(page,'/api/workspace');
  const second=workspace.projects.find(project=>project.id!==fixture.project.id);
  expect(second,'A second real registered fictional project is required.').toBeDefined();
  if(!second)throw new Error('The second registered project control is missing.');
  const primary=await read<WorkDetailResponse>(page,`/api/work/${fixture.workIds.verified}`);
  expect(primary.verification).toBe('verified');expect(primary.evidence.length).toBeGreaterThan(0);
  expect(primary.evidence.every(row=>row.freshness==='current')).toBe(true);
  await page.locator('.sidebar').getByRole('button',{name:second.name,exact:true}).click();
  await page.getByRole('button',{name:'Annotate project',exact:true}).click();
  const composer=page.getByRole('dialog',{name:'Annotate selected context',exact:true});
  const note='  A distinct fictional second-project annotation.\nKeep its own identity.  ';
  await composer.getByRole('textbox',{name:'Annotation text',exact:true}).fill(note);
  const submitted=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/annotations');
  await composer.getByRole('button',{name:'Save locally',exact:true}).click();
  const response=await submitted;expect(response.status()).toBe(201);
  const saved=await response.json() as {work:WorkDetailResponse['work']};
  const secondary=await read<WorkDetailResponse>(page,`/api/work/${saved.work.id}`);
  expect(secondary.work.projectId).toBe(second.id);expect(secondary.annotation.text).toBe(note);
  expect(secondary.verification).toBe('not_checked');expect(secondary.evidence).toEqual([]);
  expect(secondary.annotation.id).not.toBe(primary.annotation.id);
  expect(secondary.annotation.text).not.toBe(primary.annotation.text);
  for(const [project,source] of [[fixture.project,primary],[second,secondary]] as const){
    await page.locator('.sidebar').getByRole('button',{name:project.name,exact:true}).click();
    const filter=`Keep overview filter for ${project.id}`;
    const search=page.getByRole('textbox',{name:'Search project',exact:true});
    await expect(search).toHaveValue('');await search.fill(filter);
    await expect(search).toHaveValue(filter);
    for(let round=0;round<2;round++){
      const detail=await showWork(page,source.work.id);
      await expect(page.getByRole('region',{name:'Work detail',exact:true})).toHaveCount(1);
      await assertOriginal(detail,source);
      const evidence=detail.getByRole('region',{name:'Evidence',exact:true});
      await expect(evidence).toContainText(labels[source.verification]);
      for(const row of source.evidence)await expect(evidence).toContainText(row.summary);
      const list=await read<{work:WorkDetailResponse['work'][]}>(page,`/api/work?projectId=${project.id}&limit=50`);
      expect(list.work.length).toBeGreaterThan(0);expect(list.work.every(row=>row.projectId===project.id)).toBe(true);
      const center=page.getByRole('main',{name:'Work & results',exact:true});
      await expect(center).toHaveCount(1);
      const ids=await center.getByRole('button',{name:/^Open work /}).evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')!.slice('Open work '.length)));
      expect(new Set(ids).size).toBe(ids.length);expect(ids.sort()).toEqual(list.work.map(row=>row.id).sort());
      const refreshed=page.waitForResponse(value=>value.request().method()==='GET'&&new URL(value.url()).pathname===`/api/work/${source.work.id}`);
      await center.getByRole('button',{name:`Open work ${source.work.id}`,exact:true}).click();
      const current=await refreshed;expect(current.status()).toBe(200);
      expect((await current.json() as WorkDetailResponse).annotation).toEqual(source.annotation);
      if(round===0){
        const observedAt=Date.now();
        const polled=await page.waitForResponse(value=>value.request().method()==='GET'&&new URL(value.url()).pathname===`/api/work/${source.work.id}`&&Date.now()-observedAt>=5000,{timeout:15000});
        expect(polled.status()).toBe(200);
        expect((await polled.json() as WorkDetailResponse).annotation).toEqual(source.annotation);
      }
      expect(await detail.locator('.annotation-original').textContent()).toBe(source.annotation.text);
      await expect(evidence).toContainText(labels[source.verification]);
      await page.getByRole('button',{name:'Overview',exact:true}).click();
      await expect(page.getByRole('region',{name:'Project overview',exact:true})).toHaveCount(1);
      await expect(page.getByRole('region',{name:'Project overview',exact:true})).toBeVisible();
      await expect(search).toHaveValue(filter);
      await expect(page.getByRole('region',{name:'Work detail',exact:true})).toHaveCount(0);
    }
    const retained=await read<WorkDetailResponse>(page,`/api/work/${source.work.id}`);
    expect(retained.annotation).toEqual(source.annotation);expect(retained.verification).toBe(source.verification);
    expect(retained.evidence).toEqual(source.evidence);
  }
  expect(errors,'Every observed browser console error and uncaught error must be absent.').toEqual([]);
});
