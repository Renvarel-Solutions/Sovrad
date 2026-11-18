import type {Locator, Page, Response} from '@playwright/test';
import type {Decision, DecisionAction, DecisionsResponse, OverviewResponse, WorkDetailResponse, WorkflowDetailResponse, WorkspaceResponse} from '@renvarel/architect-core';
import {test, expect, type ExperienceFixtureEnvelope} from './fixtures';

let fixture:ExperienceFixtureEnvelope;

async function read<T>(page:Page,url:string):Promise<T> {
  const response=await page.request.get(url);
  expect(response.status()).toBe(200);
  return response.json() as Promise<T>;
}

async function pending(page:Page,afterSequence=0):Promise<DecisionsResponse> {
  return read(page,`/api/decisions?state=pending&limit=50&afterSequence=${afterSequence}`);
}

async function allPending(page:Page):Promise<Decision[]> {
  const rows:Decision[]=[];
  let sequence=0,digest='';
  for(let n=0;n<10;n++){
    const result=await pending(page,sequence);
    if(!digest)digest=result.page.viewDigest;
    expect(result.page.viewDigest).toBe(digest);
    rows.push(...result.decisions);
    if(!result.page.hasMore){expect(new Set(rows.map(row=>row.id)).size).toBe(result.total);return rows;}
    expect(result.page.nextAfterSequence).toBeGreaterThan(sequence);
    sequence=result.page.nextAfterSequence;
  }
  throw new Error('Synthetic decision queue did not exhaust within its bounded pages.');
}

async function globalQueue(page:Page):Promise<Locator> {
  await page.locator('.topbar').getByRole('button',{name:/^Needs your decision\b/}).click();
  const queue=page.getByRole('region',{name:'Decisions',exact:true});
  await expect(queue).toBeVisible();
  return queue;
}

async function openDecision(page:Page,id:string):Promise<Locator> {
  await page.getByRole('button',{name:`Open decision ${id}`,exact:true}).first().click();
  const detail=page.getByRole('region',{name:'Decision detail',exact:true});
  await expect(detail).toBeVisible();
  return detail;
}

function actionResponse(page:Page,id:string):Promise<Response> {
  return page.waitForResponse(response=>response.request().method()==='POST'&&
    new URL(response.url()).pathname===`/api/decisions/${id}/action`);
}

async function resolve(page:Page,id:string,action:DecisionAction['action'],reason:string):Promise<Decision> {
  const detail=await openDecision(page,id);
  const before=(await allPending(page)).find(row=>row.id===id)!;
  expect(before).toBeDefined();
  await detail.getByRole('textbox',{name:'Your reason (optional)',exact:true}).fill(reason);
  const responsePromise=actionResponse(page,id);
  await detail.getByRole('button',{name:{approve:'Approve this action',reject:'Reject',request_revision:'Request revision'}[action],exact:true}).click();
  const response=await responsePromise;
  expect(response.status()).toBe(200);
  const body=response.request().postDataJSON() as DecisionAction;
  expect(Object.keys(body).sort()).toEqual(['action','clientRequestId','expectedVersion','proposalDigest','reason']);
  expect(body).toMatchObject({action,reason,expectedVersion:before.version,proposalDigest:before.proposalDigest});
  const {decision}=await response.json() as {decision:Decision};
  expect(decision.receipt).toMatchObject({action,reason,actor:'local-owner-session',proposalDigest:before.proposalDigest});
  return decision;
}

async function tabTo(page:Page,target:Locator):Promise<void> {
  for(let n=0;n<45;n++){
    await page.keyboard.press('Tab');
    if(await target.evaluate(element=>element===document.activeElement)){
      const visibleFocus=await target.evaluate(element=>{
        const style=getComputedStyle(element);
        return (style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>0)||style.boxShadow!=='none';
      });
      expect(visibleFocus,'Keyboard focus needs a visible outline or shadow.').toBe(true);
      await expect(target).toBeInViewport();
      return;
    }
  }
  throw new Error('Decision action was not reachable by keyboard.');
}

test.beforeEach(async({page,servers})=>{
  fixture=await servers.startExperience();
  const workspace=await read<WorkspaceResponse>(page,'/api/workspace');
  expect(workspace.pendingDecisionCount).toBe(125);
  expect(workspace.pendingDecisions).toHaveLength(50);
  const first=await pending(page);
  expect(first.total).toBe(125);expect(first.decisions).toHaveLength(50);
  expect(first.page.viewDigest).toMatch(/^[a-f0-9]{64}$/);
  for(const [id,verification] of [[fixture.workIds.verified,'verified'],[fixture.workIds.verifiedControl,'verified'],
    [fixture.workIds.failed,'failed'],[fixture.workIds.checking,'not_checked']] as const){
    expect((await read<WorkDetailResponse>(page,`/api/work/${id}`)).verification).toBe(verification);
  }
  const boot=await page.request.get('/api/local-session');
  expect(boot.status()).toBe(200);
  const cookies=await page.context().cookies();
  const cookie=cookies.find(value=>value.name==='sovrad_local_action');
  expect(cookie!==undefined&&cookie.httpOnly&&cookie.path==='/api'&&cookie.sameSite==='Strict').toBe(true);
  await page.goto('/');
});

test('one pending request and its exact counts remain reachable globally, on its project, Work and node',async({page})=>{
  const global=page.locator('.topbar').getByRole('button',{name:/^Needs your decision\b/});
  await expect(global).toContainText('125');
  await globalQueue(page);
  const source=(await allPending(page)).find(row=>row.id===fixture.decisionIds.approve)!;
  await expect(await openDecision(page,source.id)).toContainText(source.explanation.action);
  await page.locator('.sidebar').getByRole('button',{name:fixture.project.name,exact:true}).click();
  await expect(global).toContainText('125');
  const project=await read<OverviewResponse>(page,`/api/projects/${fixture.project.id}/overview`);
  await expect(page.getByRole('region',{name:'Project overview',exact:true})).toContainText(`Needs your decision ${project.pendingDecisionCount}`);
  await page.getByRole('button',{name:'Decisions',exact:true}).click();
  await expect(await openDecision(page,source.id)).toContainText(source.explanation.action);
  await page.getByRole('button',{name:'Work & results',exact:true}).click();
  await page.getByRole('button',{name:`Open work ${source.workId}`,exact:true}).click();
  const work=await read<WorkDetailResponse>(page,`/api/work/${source.workId}`);
  const workRegion=page.getByRole('region',{name:'Work detail',exact:true});
  await expect(workRegion).toContainText(`Needs your decision ${work.pendingDecisionCount}`);
  await workRegion.getByRole('button',{name:`Open decision ${source.id}`,exact:true}).click();
  await expect(page.getByRole('region',{name:'Decision detail',exact:true})).toContainText(source.explanation.action);
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:`Open ${fixture.workflow.name}`,exact:true}).click();
  const node=page.locator(`.react-flow__node[data-id="${source.context.stepId}"]`);
  await node.click();
  const inspector=page.getByRole('complementary',{name:'Stage inspector',exact:true});
  const workflow=await read<WorkflowDetailResponse>(page,`/api/workflows/${fixture.workflow.id}`);
  const nodeCount=workflow.stepVerification.find(value=>value.stepId===source.context.stepId)!.pendingDecisionCount;
  expect(nodeCount).toBe(1);await expect(inspector).toContainText(`Needs your decision ${nodeCount}`);
  await inspector.getByRole('button',{name:`Open decision ${source.id}`,exact:true}).click();
  const approved=await resolve(page,source.id,'approve','');
  expect(approved.status).toBe('approved');
  await expect.poll(async()=>(await read<WorkspaceResponse>(page,'/api/workspace')).pendingDecisionCount).toBe(124);
  await expect(global).toContainText('124');
  expect((await read<WorkDetailResponse>(page,`/api/work/${source.workId}`)).pendingDecisionCount).toBe(0);
  const sibling=(await allPending(page)).find(row=>row.id===fixture.decisionIds.reject);
  expect(sibling?.status).toBe('pending');
});

test('390px shows the entire critical explanation before all three keyboard actions and approves once',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await globalQueue(page);
  const decision=(await allPending(page)).find(row=>row.id===fixture.decisionIds.approve)!;
  const detail=await openDecision(page,decision.id);
  const explanation=detail.getByRole('region',{name:'Decision explanation',exact:true});
  const values=[decision.explanation.action,decision.explanation.reasonOutsideGrant,decision.explanation.expectedResult,
    ...decision.explanation.directEffects,...decision.explanation.indirectEffects,...decision.explanation.uncertainties,
    decision.explanation.failure,decision.explanation.interruption,decision.explanation.detection,
    decision.explanation.recovery,decision.explanation.backup,decision.explanation.irreversibility,
    ...decision.explanation.alternatives,decision.explanation.recommendation];
  for(const value of values){
    const text=explanation.getByText(value,{exact:true}).first();
    await expect(text).toBeVisible();await text.scrollIntoViewIfNeeded();await expect(text).toBeInViewport();
  }
  await expect(explanation).toContainText(/one.time.*(free|\$0(?:\.00)?)/is);
  await expect(explanation).toContainText(/ongoing.*unknown/is);
  await expect(explanation).toContainText(/cap.*(\$0|free|0)/is);
  await expect(explanation).toContainText(decision.explanation.cost.payer);
  const buttons=['Approve this action','Reject','Request revision'].map(name=>detail.getByRole('button',{name,exact:true}));
  for(const button of buttons){
    expect(await explanation.evaluate((element,label)=>{
      const target=[...element.parentElement!.querySelectorAll('button')].find(value=>value.textContent?.trim()===label);
      return !!target&&!!(element.compareDocumentPosition(target)&Node.DOCUMENT_POSITION_FOLLOWING);
    },await button.innerText()),'Critical explanation must precede every action in reading order.').toBe(true);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const reason=detail.getByRole('textbox',{name:'Your reason (optional)',exact:true});
  const exactReason='  Reviewed the bounded fictional request.\nKeep this spacing.  ';
  await reason.fill(exactReason);await reason.focus();
  for(const button of buttons)await tabTo(page,button);
  await tabTo(page,buttons[0]);
  const mutations:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===`/api/decisions/${decision.id}/action`)mutations.push(request.postData()??'');});
  const responsePromise=actionResponse(page,decision.id);await page.keyboard.press('Enter');
  const response=await responsePromise;expect(response.status()).toBe(200);
  const result=await response.json() as {decision:Decision};
  expect(result.decision.receipt).toMatchObject({reason:exactReason,actor:'local-owner-session',action:'approve'});
  expect(response.request().postDataJSON()).toMatchObject({expectedVersion:decision.version,proposalDigest:decision.proposalDigest,reason:exactReason});
  const work=await read<WorkDetailResponse>(page,`/api/work/${decision.workId}`);
  expect(work.work.state).toBe('blocked');expect(work.work.blockers.join(' ')).toMatch(/unavailable/i);
  const observedAt=Date.now();
  const poll=page.waitForResponse(value=>value.request().method()==='GET'&&new URL(value.url()).pathname==='/api/workspace'&&Date.now()-observedAt>=5000,{timeout:15000});
  await poll;expect(mutations).toHaveLength(1);
  await expect(detail).not.toContainText(/working now|agent running|\d+% complete/i);
  expect(await page.evaluate(()=>document.cookie.includes('sovrad_local_action'))).toBe(false);
});

test('Reject and Request revision retain exact optional reasons and never create executable permission',async({page})=>{
  await globalQueue(page);
  const before=await allPending(page);
  const rejected=await resolve(page,fixture.decisionIds.reject,'reject','');
  expect(rejected.status).toBe('rejected');
  const revised=await resolve(page,fixture.decisionIds.requestRevision,'request_revision','  Narrow the fictional request.\nKeep the current rule.  ');
  expect(revised.status).toBe('revision_requested');
  for(const [decision,blocker] of [[rejected,/reject/i],[revised,/revis|resubmit/i]] as const){
    const detail=await read<WorkDetailResponse>(page,`/api/work/${decision.workId}`);
    expect(detail.work.state).toBe('blocked');expect(detail.work.blockers.join(' ')).toMatch(blocker);
    expect(detail.verification).not.toBe('verified');
    expect(detail.decisions.find(row=>row.id===decision.id)?.receipt).toEqual(decision.receipt);
    expect(detail.annotation.id).toBe(detail.work.annotationId);
    expect(detail.events.some(event=>blocker.test(event.detail))).toBe(true);
  }
  expect((await allPending(page)).length).toBe(before.length-2);
  await page.reload();await globalQueue(page);
  await expect(page.getByRole('button',{name:`Open decision ${rejected.id}`,exact:true})).toHaveCount(0);
  const persisted=await read<WorkDetailResponse>(page,`/api/work/${revised.workId}`);
  expect(persisted.decisions.find(row=>row.id===revised.id)?.receipt).toEqual(revised.receipt);
  expect(persisted.decisions.some(row=>row.id!==revised.id&&row.status==='approved')).toBe(false);
});

test('the full125 queue uses a consistent digest and equal-total membership changes reset pages without losing reason drafts',async({page,servers})=>{
  const queue=await globalQueue(page);
  await expect(queue).toContainText('Showing 50 of 125');
  await expect(queue.getByText(/Complete.*list loaded/i)).toHaveCount(0);
  const first=await pending(page),second=await pending(page,first.page.nextAfterSequence);
  expect(first.page.limit).toBe(50);expect(second.page.limit).toBe(50);
  expect(second.page.viewDigest).toBe(first.page.viewDigest);
  expect((await pending(page)).page.viewDigest).toBe(first.page.viewDigest);
  await queue.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(queue).toContainText('Showing 100 of 125');
  await queue.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(queue).toContainText('Showing 125 of 125');
  await expect(queue.getByText(/Complete.*list loaded/i)).toBeVisible();
  const expected=await allPending(page);
  expect((await queue.locator('[data-decision-id]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-decision-id')))).sort()).toEqual(expected.map(row=>row.id).sort());
  await expect(await openDecision(page,fixture.decisionIds.lastPending)).toContainText(expected.at(-1)!.explanation.action);
  await page.locator('.sidebar').getByRole('button',{name:fixture.project.name,exact:true}).click();
  await globalQueue(page);
  await expect(queue).toContainText('Showing 50 of 125');
  const draft=await openDecision(page,fixture.decisionIds.reject);
  const reason='  Preserve this unsent queue reason.  ';
  await draft.getByRole('textbox',{name:'Your reason (optional)',exact:true}).fill(reason);
  const posted:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&/\/api\/decisions\/[^/]+\/action$/.test(new URL(request.url()).pathname))posted.push(request.url());});
  const beforeChange=await pending(page);
  const changed=await servers.experienceChange({kind:'resolve_pending_and_replace'});
  expect(changed.kind).toBe('resolve_pending_and_replace');if(changed.kind!=='resolve_pending_and_replace')throw new Error('Wrong fixture acknowledgement.');
  const afterChange=await pending(page);
  expect(beforeChange.page.limit).toBe(50);expect(afterChange.page.limit).toBe(50);
  expect(beforeChange.total).toBe(125);expect(afterChange.total).toBe(125);
  expect(afterChange.page.viewDigest).not.toBe(beforeChange.page.viewDigest);
  expect(changed.pendingTotal).toBe(125);expect(changed.viewDigest).toBe(afterChange.page.viewDigest);
  await queue.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(queue).toContainText('Showing 50 of 125');
  await expect(queue).toContainText(/changed|refresh.*beginning/i);
  await expect(queue.getByText(/Complete.*list loaded/i)).toHaveCount(0);
  await expect(draft.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue(reason);
  await queue.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(queue).toContainText('Showing 100 of 125');
  await queue.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(queue).toContainText('Showing 125 of 125');
  const current=await allPending(page);
  expect(current.some(row=>row.id===changed.removedDecisionId)).toBe(false);
  expect(current.some(row=>row.id===changed.replacementDecisionId)).toBe(true);
  expect((await queue.locator('[data-decision-id]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-decision-id')))).sort()).toEqual(current.map(row=>row.id).sort());
  expect(posted).toHaveLength(0);
  const last=await resolve(page,fixture.decisionIds.lastPending,'reject','');
  expect(last.status).toBe('rejected');
});

test('real409 and403 retain drafts and require explicit recovery without automatic action retries',async({page,servers})=>{
  await globalQueue(page);
  const stale=await openDecision(page,fixture.decisionIds.stale);
  const reason='Keep this reason after a changed request.';
  await stale.getByRole('textbox',{name:'Your reason (optional)',exact:true}).fill(reason);
  const attempts:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&/\/api\/decisions\/[^/]+\/action$/.test(new URL(request.url()).pathname))attempts.push(new URL(request.url()).pathname);});
  let releaseReads:()=>void=()=>{};
  const heldReads=new Promise<void>(resolve=>{releaseReads=resolve;});
  const readPattern='**/api/{decisions,workspace}*';
  await page.route(readPattern,async route=>{
    if(route.request().method()==='GET')await heldReads;
    await route.continue();
  });
  try{
    await servers.experienceChange({kind:'invalidate_source',workId:fixture.workIds.stale});
    const conflict=actionResponse(page,fixture.decisionIds.stale);
    await stale.getByRole('button',{name:'Approve this action',exact:true}).click();
    expect((await conflict).status()).toBe(409);
  }finally{releaseReads();await page.unroute(readPattern);}
  await expect(stale.getByRole('alert')).toBeVisible();
  await expect(stale.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue(reason);
  await stale.getByRole('button',{name:'Refresh request',exact:true}).click();
  await expect(stale).toContainText(/superseded|changed|no longer pending/i);
  const conflictObservedAt=Date.now();
  const afterConflict=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/workspace'&&Date.now()-conflictObservedAt>=5000,{timeout:15000});
  await afterConflict;expect(attempts).toHaveLength(1);
  await globalQueue(page);
  const sibling=await openDecision(page,fixture.decisionIds.approve);
  await sibling.getByRole('textbox',{name:'Your reason (optional)',exact:true}).fill('  Keep this optional reason.  ');
  await page.context().clearCookies();
  const forbidden=actionResponse(page,fixture.decisionIds.approve);
  await sibling.getByRole('button',{name:'Approve this action',exact:true}).click();
  const denied=await forbidden;expect(denied.status()).toBe(403);
  expect((await denied.json()).code).toBe('LOCAL_SESSION_REQUIRED');
  await expect(sibling.getByRole('textbox',{name:'Your reason (optional)',exact:true})).toHaveValue('  Keep this optional reason.  ');
  const forbiddenObservedAt=Date.now();
  const afterForbidden=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/workspace'&&Date.now()-forbiddenObservedAt>=5000,{timeout:15000});
  await afterForbidden;expect(attempts).toHaveLength(2);
  await sibling.getByRole('button',{name:'Renew local session',exact:true}).click();
  expect(attempts).toHaveLength(2);
  const approved=await resolve(page,fixture.decisionIds.approve,'approve','  Keep this optional reason.  ');
  expect(approved.status).toBe('approved');expect(attempts).toHaveLength(3);
});
