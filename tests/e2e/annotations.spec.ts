import type {APIRequestContext, Locator, Page} from '@playwright/test';
import {
  buildSelectedAnnotationMaterial, digestSelectedAnnotationMaterial, serializeSelectedAnnotationMaterial,
  type Annotation, type AnnotationInput, type ContextRef, type OverviewResponse, type ProjectItem,
  type RegisteredProject, type SelectedAnnotationMaterialV1, type WorkDetailResponse, type WorkItem,
  type Workflow, type WorkflowDetailResponse, type WorkspaceResponse,
} from '@renvarel/architect-core';
import {test, expect, createProject, post} from './fixtures';

type Intake = {annotation:Annotation; work:WorkItem};
type Scenario = {project:RegisteredProject; item:ProjectItem; workflow:Workflow; child:Workflow};
const exactText = '  Keep <strong>literal</strong> text.\nسطر ثانٍ 🧭\nFinal line.  ';

async function overview(request:APIRequestContext, id:string):Promise<OverviewResponse> {
  const response=await request.get(`/api/projects/${id}/overview`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function scenario(request:APIRequestContext):Promise<Scenario> {
  let project=await createProject(request,`Fictional annotation desk ${crypto.randomUUID().slice(0,8)}`);
  const {item}=await post<{item:ProjectItem}>(request,`/api/projects/${project.id}/items`,{
    clientRequestId:crypto.randomUUID(),expectedMapRevision:project.mapRevision,parentId:null,
    kind:'feature',name:'Fictional intake item',description:'Retained parent item.',development:'planning',workflowId:null,
  });
  project=(await overview(request,project.id)).project;
  const step={id:'review',title:'Review selected input',kind:'process' as const,purpose:'Inspect only the selected input.',
    rules:['Retain the original input.'],inputs:['Selected input'],outputs:['Review result'],
    errorBehavior:'Explain the correction.',position:{x:0,y:0}};
  const {workflow:child}=await post<{workflow:Workflow}>(request,`/api/projects/${project.id}/workflows`,{
    clientRequestId:crypto.randomUUID(),expectedMapRevision:project.mapRevision,itemId:null,
    name:'Fictional child map',description:'Nested selected workflow.',steps:[{...step,id:'nested',title:'Nested check'}],connections:[],
  });
  project=(await overview(request,project.id)).project;
  const {workflow}=await post<{workflow:Workflow}>(request,`/api/projects/${project.id}/workflows`,{
    clientRequestId:crypto.randomUUID(),expectedMapRevision:project.mapRevision,itemId:item.id,
    name:'Fictional selected map',description:'Only the chosen stage is sent.',
    steps:[{...step,childWorkflowId:child.id},{...step,id:'sibling',title:'Unselected sibling sentinel',position:{x:320,y:0}}],
    connections:[{id:'review-next',source:'review',target:'sibling',label:'Next'}],
  });
  const current=await overview(request,project.id);
  return {project:current.project,item:current.items.find(value=>value.id===item.id)!,workflow,child};
}

async function selectProject(page:Page, data:Scenario):Promise<void> {
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:data.project.name,exact:true}).click();
  await expect(page.getByRole('heading',{name:data.project.name,exact:true})).toBeVisible();
}

async function openMap(page:Page, data:Scenario):Promise<void> {
  await selectProject(page,data);
  await page.locator(`[data-item-id="${data.item.id}"]`).getByRole('button',{name:'Open workflow',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review selected input',exact:true})).toBeVisible();
}

async function composer(page:Page, action:string):Promise<Locator> {
  const button=page.getByRole('button',{name:action,exact:true});
  await expect(button).toBeEnabled();
  await button.click();
  const dialog=page.getByRole('dialog',{name:/Annotat|Amend/});
  await expect(dialog).toBeVisible();
  return dialog;
}

async function preview(dialog:Locator):Promise<SelectedAnnotationMaterialV1> {
  const material=dialog.getByRole('region',{name:'Selected material',exact:true});
  await expect(material).toBeVisible();
  await material.getByText('Exact selected JSON',{exact:true}).click();
  const json=material.locator('pre');
  await expect(json).toContainText('"schemaVersion":1');
  return JSON.parse((await json.textContent())!);
}

async function save(page:Page, dialog:Locator, connected=false):Promise<Intake> {
  const response=page.waitForResponse(value=>value.request().method()==='POST'&&
    (/\/api\/annotations$/.test(value.url())||/\/api\/work\/[^/]+\/amend$/.test(value.url())));
  await dialog.getByRole('button',{name:connected?'Send instruction':'Save locally',exact:true}).click();
  const result=await response;
  expect(/\/amend$/.test(result.url())?[200,201]:[201],await result.text()).toContain(result.status());
  const intake=await result.json() as Intake;
  expect(intake.annotation.id).toBe(intake.work.annotationId);
  expect(intake.annotation.context.projectId).toBe(intake.work.projectId);
  return intake;
}

async function workDetail(request:APIRequestContext, id:string):Promise<WorkDetailResponse> {
  const response=await request.get(`/api/work/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function showWork(page:Page, id:string):Promise<Locator> {
  await page.getByRole('button',{name:'Work & results',exact:true}).click();
  await page.getByRole('button',{name:`Open work ${id}`,exact:true}).click();
  const detail=page.getByRole('region',{name:'Work detail',exact:true});
  await expect(detail).toBeVisible();
  return detail;
}

async function localInput(data:Scenario,text:string):Promise<AnnotationInput> {
  const context:ContextRef={projectId:data.project.id,mapRevision:data.project.mapRevision};
  const draft={context,text,target:'automatic' as const,intent:'instruction' as const,promoteFuture:false};
  const material=buildSelectedAnnotationMaterial({draft,project:data.project,item:null,workflow:null,step:null});
  return {...draft,clientRequestId:crypto.randomUUID(),dispatch:{mode:'local',consent:false,
    contextDigest:await digestSelectedAnnotationMaterial(material)}};
}

test.beforeEach(async ({request})=>{
  await post(request,'/api/workspace/access',{mode:'all_connected',selectedProjectIds:[]});
});

test('local notes work with AI off at project, workflow, stage and nested child while retaining the parent item',async({page,request})=>{
  const data=await scenario(request);
  await selectProject(page,data);
  let dialog=await composer(page,'Annotate project');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill('Project-level local note.');
  const projectNote=await save(page,dialog);
  expect(projectNote.annotation.context).toEqual({projectId:data.project.id,mapRevision:data.project.mapRevision});
  expect(projectNote.annotation.consentReceipt).toBeNull();
  await openMap(page,data);
  dialog=await composer(page,'Annotate workflow');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill('Whole selected workflow note.');
  const workflowNote=await save(page,dialog);
  expect(workflowNote.annotation.context).toEqual({projectId:data.project.id,itemId:data.item.id,
    workflowId:data.workflow.id,specRevision:1,mapRevision:data.project.mapRevision});
  await openMap(page,data);
  dialog=await composer(page,'Annotate this stage');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill('Selected stage local note.');
  const stage=await save(page,dialog);
  expect(stage.annotation.context).toEqual({...workflowNote.annotation.context,stepId:'review'});
  await page.getByRole('button',{name:'Open child workflow',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Nested check',exact:true})).toBeVisible();
  dialog=await composer(page,'Annotate this stage');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill(exactText);
  const nested=await save(page,dialog);
  expect(nested.annotation.context).toEqual({...stage.annotation.context,workflowId:data.child.id,stepId:'nested'});
  expect(nested.annotation.material.selection.item?.id).toBe(data.item.id);
  expect(nested.annotation.text).toBe(exactText);
  expect((await workDetail(request,nested.work.id)).events.length).toBeGreaterThan(0);
  const rows=await (await request.get(`/api/work?projectId=${data.project.id}`)).json() as {work:WorkItem[]};
  expect(rows.work).toHaveLength(4);
  expect(rows.work.every(value=>value.interpretation===null&&value.state!=='working'&&value.state!=='understanding')).toBe(true);
});

test('Automatic, Codex and ChatGPT preview only explicit selected plaintext and submit matching canonical material',async({page,request})=>{
  const data=await scenario(request);
  for(const target of ['automatic','codex','chatgpt'] as const){
    await openMap(page,data);
    const dialog=await composer(page,'Annotate this stage');
    await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill(exactText);
    await dialog.getByRole('combobox',{name:'Target',exact:true}).selectOption(target);
    const material=dialog.getByRole('region',{name:'Selected material',exact:true});
    await expect(material).toContainText('Review selected input');
    await expect(material).toContainText('Retain the original input.');
    await expect(material).toContainText('<strong>literal</strong>');
    await expect(material.locator('strong').filter({hasText:'literal'})).toHaveCount(0);
    await expect(material).not.toContainText('Unselected sibling sentinel');
    const shown=await preview(dialog);
    expect(Object.keys(shown)).toEqual(['schemaVersion','context','text','target','intent','promoteFuture','selection']);
    expect(Object.keys(shown.selection)).toEqual(['project','item','workflow','step']);
    expect(Object.keys(shown.selection.project)).toEqual(['id','name','description']);
    expect(Object.keys(shown.selection.step!)).toEqual(['id','title','purpose','rules','inputs','outputs','errorBehavior']);
    expect(shown.text).toBe(exactText);
    expect(shown.target).toBe(target);
    const saved=await save(page,dialog);
    expect(saved.annotation.material).toEqual(shown);
    expect(saved.annotation.materialJSON).toBe(serializeSelectedAnnotationMaterial(shown));
    expect(saved.annotation.dispatch.contextDigest).toBe(await digestSelectedAnnotationMaterial(shown));
    expect(saved.annotation.dispatch).toMatchObject({mode:'local',consent:false});
  }
});

test('unavailable connected intake needs explicit fresh consent and shows blocked work without invented progress',async({page,request})=>{
  const data=await scenario(request);
  await openMap(page,data);
  const dialog=await composer(page,'Annotate this stage');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill('Please inspect this fictional rule.');
  await dialog.getByRole('combobox',{name:'Target',exact:true}).selectOption('codex');
  await dialog.getByRole('combobox',{name:'Send mode',exact:true}).selectOption('connected');
  const send=dialog.getByRole('button',{name:'Send instruction',exact:true});
  await expect(send).toBeDisabled();
  await dialog.getByRole('checkbox',{name:/I approve sending/}).check();
  const material=await preview(dialog);
  const result=await save(page,dialog,true);
  expect(result.work.state).toBe('blocked');
  expect(result.work.interpretation).toBeNull();
  expect(result.work.blockers.join(' ')).toMatch(/unavailable|offline|not ready|adapter/i);
  expect(result.annotation.consentReceipt).toMatchObject({annotationId:result.annotation.id,
    annotationRevision:result.annotation.revision,target:'codex',contextDigest:await digestSelectedAnnotationMaterial(material)});
  const detail=await showWork(page,result.work.id);
  await expect(detail).toContainText(/blocked/i);
  await expect(detail).toContainText(/unavailable|offline|not ready|adapter/i);
  await expect(detail.getByRole('progressbar')).toHaveCount(0);
  await expect(detail).not.toContainText(/working now|understanding your|\d+% complete/i);
  await expect(detail).toContainText(/acceptance.*(unknown|unavailable|not available)/i);
  await expect(detail.getByRole('region',{name:'History',exact:true})).not.toBeEmpty();
});

test('Work detail and amendment read the exact immutable annotation even when annotation discovery is empty',async({page,request})=>{
  const data=await scenario(request);
  await openMap(page,data);
  let dialog=await composer(page,'Annotate this stage');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill(exactText);
  await dialog.getByRole('combobox',{name:'Target',exact:true}).selectOption('chatgpt');
  await dialog.getByRole('combobox',{name:'Intent',exact:true}).selectOption('question');
  const first=await save(page,dialog);
  await post<Intake>(request,'/api/annotations',await localInput(data,'Unrelated latest annotation sentinel.'));
  // An empty bounded discovery page must never replace GET /work/:id.annotation.
  await page.route('**/api/annotations?**',route=>route.fulfill({json:{annotations:[]}}));
  await page.route('**/api/annotations',async route=>{
    if(route.request().method()==='GET')await route.fulfill({json:{annotations:[]}});else await route.continue();
  });
  await page.reload();
  await page.locator('.sidebar').getByRole('button',{name:data.project.name,exact:true}).click();
  let detail=await showWork(page,first.work.id);
  expect(await detail.getByLabel('Original annotation text',{exact:true}).textContent()).toBe(exactText);
  await expect(detail).toContainText('ChatGPT');
  await expect(detail).toContainText(/question/i);
  dialog=await composer(page,'Amend instruction');
  await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(exactText);
  await expect(dialog.getByRole('combobox',{name:'Target',exact:true})).toHaveValue('chatgpt');
  await expect(dialog.getByRole('combobox',{name:'Intent',exact:true})).toHaveValue('question');
  const changed='Edited revision.\nلا تغيّر الأصل 🧭';
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill(changed);
  const amended=await save(page,dialog);
  expect(amended.annotation.id).not.toBe(first.annotation.id);
  expect(amended.annotation.supersedesId).toBe(first.annotation.id);
  expect(amended.annotation.text).toBe(changed);
  const original=await workDetail(request,first.work.id);
  expect(original.annotation).toEqual(first.annotation);
  expect(original.work.state).toBe('superseded');
  expect(original.events.length).toBeGreaterThan(1);
  detail=await showWork(page,first.work.id);
  expect(await detail.getByLabel('Original annotation text',{exact:true}).textContent()).toBe(exactText);
  await expect(detail.getByRole('region',{name:'History',exact:true})).toContainText(/supersed|amend/i);
});

test('five-second polling preserves drafts and consent; layout preserves consent while semantic changes reset it',async({page,request})=>{
  const data=await scenario(request);
  await openMap(page,data);
  const dialog=await composer(page,'Annotate this stage');
  const text=dialog.getByRole('textbox',{name:'Annotation text',exact:true});
  const consent=dialog.getByRole('checkbox',{name:/I approve sending/});
  await text.fill(exactText);
  await dialog.getByRole('combobox',{name:'Send mode',exact:true}).selectOption('connected');
  await consent.check();
  const initial=await preview(dialog);
  const workflowPoll=page.waitForResponse(value=>value.request().method()==='GET'&&
    new URL(value.url()).pathname===`/api/workflows/${data.workflow.id}`,{timeout:12000});
  await workflowPoll;
  await expect(text).toHaveValue(exactText);
  await expect(consent).toBeChecked();
  const current=await (await request.get(`/api/workflows/${data.workflow.id}`)).json() as WorkflowDetailResponse;
  await post(request,`/api/workflows/${data.workflow.id}/layout`,{expectedLayoutRevision:current.layout.layoutRevision,
    positions:current.layout.positions.map(position=>({...position,x:position.x+40}))});
  await page.waitForResponse(value=>value.request().method()==='GET'&&
    new URL(value.url()).pathname===`/api/workflows/${data.workflow.id}`,{timeout:12000});
  await expect(consent).toBeChecked();
  await expect(text).toHaveValue(exactText);
  // The disclosure remains open through a poll; its exact material is unchanged by layout.
  expect(JSON.parse((await dialog.getByRole('region',{name:'Selected material'}).locator('pre').textContent())!)).toEqual(initial);
  await text.fill(exactText+' edited');
  await expect(consent).not.toBeChecked();
  await consent.check();
  await dialog.getByRole('combobox',{name:'Target',exact:true}).selectOption('chatgpt');
  await expect(consent).not.toBeChecked();
  await consent.check();
  await dialog.getByRole('combobox',{name:'Intent',exact:true}).selectOption('future_plan');
  await expect(consent).not.toBeChecked();
  await consent.check();
  await post(request,`/api/projects/${data.project.id}/items/${data.item.id}`,{expectedMapRevision:data.project.mapRevision,
    name:'Renamed fictional intake item',description:data.item.description,development:'planning'});
  await expect(consent).not.toBeChecked({timeout:12000});
  await expect(text).toHaveValue(exactText+' edited');
  await expect(dialog).toContainText(/context.*changed|review.*again|stale/i);
});

test('a locally saved amendment stays local across synthetic readiness, reload and real API restart',async({page,request,servers})=>{
  const data=await scenario(request);
  await openMap(page,data);
  let dialog=await composer(page,'Annotate this stage');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill('Connected A requires unavailable help.');
  await dialog.getByRole('combobox',{name:'Send mode',exact:true}).selectOption('connected');
  await dialog.getByRole('checkbox',{name:/I approve sending/}).check();
  const a=await save(page,dialog,true);
  await showWork(page,a.work.id);
  dialog=await composer(page,'Amend instruction');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill('Local B must stay local.\nحتى بعد إعادة الاتصال');
  await dialog.getByRole('combobox',{name:'Send mode',exact:true}).selectOption('local');
  const b=await save(page,dialog);
  expect(b.annotation.consentReceipt).toBeNull();
  expect(b.annotation.dispatch).toMatchObject({mode:'local',consent:false});
  let writes=0;
  page.on('request',value=>{if(value.method()==='POST'&&/\/api\/(annotations|work\/[^/]+\/amend)$/.test(new URL(value.url()).pathname))writes++;});
  // Presentation-only fake readiness: no real adapter/connect endpoint exists in Task 4.
  await page.route('**/api/workspace',async route=>{
    const response=await route.fetch();
    const workspace=await response.json() as WorkspaceResponse;
    workspace.connections=[{id:'fictional-ready',target:'codex',state:'ready',capabilities:['interpret'],
      lastSeenAt:'2026-01-01T00:00:00.000Z',reason:'Synthetic browser presentation only.'}];
    await route.fulfill({response,json:workspace});
  });
  const restarted=await servers.restartAPI();
  expect(restarted.nextPID).not.toBe(restarted.previousPID);
  await page.reload();
  await page.locator('.sidebar').getByRole('button',{name:data.project.name,exact:true}).click();
  const detail=await showWork(page,b.work.id);
  await expect(detail).toContainText(/kept in sovrad|local only|local note/i);
  await page.waitForResponse(value=>value.request().method()==='GET'&&
    new URL(value.url()).pathname===`/api/work/${b.work.id}`,{timeout:12000});
  expect(writes).toBe(0);
  const reloaded=await workDetail(request,b.work.id);
  expect(reloaded.annotation).toEqual(b.annotation);
  expect(reloaded.work.interpretation).toBeNull();
  expect(['understanding','working','checking','done']).not.toContain(reloaded.work.state);
  dialog=await composer(page,'Amend instruction');
  await dialog.getByRole('combobox',{name:'Send mode',exact:true}).selectOption('connected');
  await expect(dialog.getByRole('checkbox',{name:/I approve sending/})).not.toBeChecked();
  await expect(dialog.getByRole('button',{name:'Send instruction',exact:true})).toBeDisabled();
});

test('stale and wrong-context failures are visible, preserve the unsent draft and allow a deliberate retry',async({page,request})=>{
  const data=await scenario(request);
  await openMap(page,data);
  const dialog=await composer(page,'Annotate this stage');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill(exactText);
  let attempts=0;
  await page.route('**/api/annotations',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    attempts++;
    if(attempts===1){await route.fulfill({status:409,json:{error:'Selected context changed. Review and retry.'}});return;}
    if(attempts===2){
      const input=route.request().postDataJSON() as AnnotationInput;
      await route.continue({postData:JSON.stringify({...input,context:{...input.context,stepId:'missing-foreign-step'}})});
      return;
    }
    await route.continue();
  });
  const submit=dialog.getByRole('button',{name:'Save locally',exact:true});
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText(/context changed/i);
  await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(exactText);
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText(/not found|context|step/i);
  const failed=await (await request.get(`/api/work?projectId=${data.project.id}`)).json() as {work:WorkItem[]};
  expect(failed.work).toHaveLength(0);
  await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(exactText);
  const saved=await save(page,dialog);
  expect(saved.annotation.text).toBe(exactText);
  expect(saved.annotation.context.stepId).toBe('review');
  const successful=await (await request.get(`/api/work?projectId=${data.project.id}`)).json() as {work:WorkItem[]};
  expect(successful.work).toHaveLength(1);
  expect(attempts).toBe(3);
});

test('real stale amendment version refresh retains edits and requires fresh consent before one deliberate resubmission',async({page,request})=>{
  const data=await scenario(request);
  await openMap(page,data);
  let dialog=await composer(page,'Annotate this stage');
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill('Original connected revision A.');
  await dialog.getByRole('combobox',{name:'Send mode',exact:true}).selectOption('connected');
  await dialog.getByRole('checkbox',{name:/I approve sending/}).check();
  const original=await save(page,dialog,true);
  await showWork(page,original.work.id);
  dialog=await composer(page,'Amend instruction');
  const edited='Unsaved revision B.\nاحفظ هذه التعديلات 🧭';
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill(edited);
  await dialog.getByRole('combobox',{name:'Target',exact:true}).selectOption('chatgpt');
  await dialog.getByRole('combobox',{name:'Intent',exact:true}).selectOption('question');
  const consent=dialog.getByRole('checkbox',{name:/I approve sending/});
  await consent.check();
  await post(request,`/api/projects/${data.project.id}/items/${data.item.id}`,{expectedMapRevision:data.project.mapRevision,
    name:'Renamed item while amendment is open',description:data.item.description,development:'planning'});
  const revoked=await workDetail(request,original.work.id);
  expect(revoked.work.version).toBeGreaterThan(original.work.version);
  expect(revoked.annotation).toEqual(original.annotation);
  await expect(consent).not.toBeChecked({timeout:12000});
  await expect(dialog).toContainText(/context.*changed|review.*again/i);
  await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(edited);
  await expect(dialog.getByRole('combobox',{name:'Target',exact:true})).toHaveValue('chatgpt');
  await expect(dialog.getByRole('combobox',{name:'Intent',exact:true})).toHaveValue('question');
  let amendments=0;
  page.on('request',value=>{if(value.method()==='POST'&&new URL(value.url()).pathname===`/api/work/${original.work.id}/amend`)amendments++;});
  await consent.check();
  const conflict=page.waitForResponse(value=>value.request().method()==='POST'&&
    new URL(value.url()).pathname===`/api/work/${original.work.id}/amend`);
  await dialog.getByRole('button',{name:'Send instruction',exact:true}).click();
  expect((await conflict).status()).toBe(409);
  await expect(dialog.getByRole('alert')).toContainText(/work changed.*refresh/i);
  const refresh=page.waitForResponse(value=>value.request().method()==='GET'&&
    new URL(value.url()).pathname===`/api/work/${original.work.id}`);
  await dialog.getByRole('button',{name:'Refresh selected context',exact:true}).click();
  await refresh;
  await expect(consent).not.toBeChecked();
  await expect(dialog.getByRole('button',{name:'Send instruction',exact:true})).toBeDisabled();
  await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(edited);
  await expect(dialog.getByRole('combobox',{name:'Target',exact:true})).toHaveValue('chatgpt');
  await expect(dialog.getByRole('combobox',{name:'Intent',exact:true})).toHaveValue('question');
  expect(amendments).toBe(1);
  const current=await preview(dialog);
  expect(current.selection.item?.name).toBe('Renamed item while amendment is open');
  await consent.check();
  const saved=await save(page,dialog,true);
  expect(amendments).toBe(2);
  expect(saved.annotation).toMatchObject({text:edited,target:'chatgpt',intent:'question',supersedesId:original.annotation.id});
  expect(saved.annotation.consentReceipt?.contextDigest).toBe(await digestSelectedAnnotationMaterial(current));
  const rows=await (await request.get(`/api/work?projectId=${data.project.id}`)).json() as {work:WorkItem[]};
  expect(rows.work).toHaveLength(2);
  expect((await workDetail(request,original.work.id)).work.state).toBe('superseded');
});
