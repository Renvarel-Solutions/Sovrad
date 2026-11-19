import type {APIRequestContext, Locator, Page} from '@playwright/test';
import type {AgentConnection, OverviewResponse, RegisteredProject, Workflow} from '@renvarel/architect-core';
import {test, expect, createProject, post} from './fixtures';

type FakeMode='accepted'|'refused'|'throw'|'absent'|'partial';
type HostCall={text:string;html:string;connected:boolean;visible:boolean;metadata:Record<string,unknown>;initialComment:string;omitScreenshot:boolean};
type FakeHost={mode:FakeMode;calls:HostCall[];targets:HTMLElement[]};
type HostWindow=Window&{__sovradHost:FakeHost};
type Scenario={project:RegisteredProject;workflow:Workflow};
const fullAnnotation='FULL_ANNOTATION_ADJACENT_SENTINEL — retain this entire local draft.';
const selectedDescription='SELECTED_DESCRIPTION_ADJACENT_SENTINEL';
const selectedRule='SELECTED_RULE_ADJACENT_SENTINEL';
const approval='I approve sharing this reference and short comment with the desktop host.';
const shortComment='  Review this reference.\nسؤال 🧭 <strong>literal</strong>  ';

async function installHost(page:Page,mode:FakeMode='accepted'):Promise<void> {
  await page.addInitScript(({mode})=>{
    const state:FakeHost={mode,calls:[],targets:[]};
    (window as HostWindow).__sovradHost=state;
    const request=(target:HTMLElement,options:{metadata:Record<string,unknown>;initialComment:string;omitScreenshot:boolean}):{accepted:boolean}=>{
      state.targets.push(target);
      state.calls.push({text:target.textContent??'',html:target.outerHTML,connected:target.isConnected,
        visible:target.getClientRects().length>0,metadata:options.metadata,initialComment:options.initialComment,omitScreenshot:options.omitScreenshot});
      if(state.mode==='throw')throw new Error('Synthetic host refusal.');
      return {accepted:state.mode==='accepted'};
    };
    Object.defineProperty(document,'oai',{configurable:true,value:mode==='absent'?undefined:
      {annotation:mode==='partial'?{request:'unsupported'}:{request}}});
  },{mode});
}

async function calls(page:Page):Promise<HostCall[]> {
  return page.evaluate(()=>(window as HostWindow).__sovradHost.calls);
}

async function scenario(request:APIRequestContext):Promise<Scenario> {
  let project=await createProject(request,`Fictional host desk ${crypto.randomUUID().slice(0,8)}`);
  const {workflow}=await post<{workflow:Workflow}>(request,`/api/projects/${project.id}/workflows`,{
    clientRequestId:crypto.randomUUID(),expectedMapRevision:project.mapRevision,itemId:null,
    name:'Fictional handoff map',description:selectedDescription,
    steps:[{id:'review',title:'Review reference',kind:'process',purpose:'Inspect a fictional reference.',rules:[selectedRule],
      inputs:['Fictional input'],outputs:['Fictional result'],errorBehavior:'Explain a correction.',position:{x:0,y:0}}],connections:[],
  });
  const current=await request.get(`/api/projects/${project.id}/overview`);
  expect(current.ok()).toBe(true);
  project=(await current.json() as OverviewResponse).project;
  return {project,workflow};
}

async function openComposer(page:Page,data:Scenario,stage=true):Promise<Locator> {
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:data.project.name,exact:true}).click();
  if(stage){
    await page.getByRole('button',{name:`Open ${data.workflow.name}`,exact:true}).click();
    await page.getByRole('button',{name:'Annotate this stage',exact:true}).click();
  }else await page.getByRole('button',{name:'Annotate project',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Annotate selected context',exact:true});
  await expect(dialog.getByRole('region',{name:'Selected material',exact:true})).toBeVisible();
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill(fullAnnotation);
  return dialog;
}

function handoff(dialog:Locator):Locator {
  return dialog.getByRole('region',{name:'External host handoff',exact:true});
}

async function approve(dialog:Locator,comment=shortComment):Promise<Locator> {
  const area=handoff(dialog);
  await area.getByRole('textbox',{name:'Short host comment',exact:true}).fill(comment);
  await area.getByRole('checkbox',{name:approval,exact:true}).check();
  const action=area.getByRole('button',{name:'Open host annotation',exact:true});
  await expect(action).toBeEnabled();
  return action;
}

function recordWrites(page:Page):string[] {
  const writes:string[]=[];
  page.on('request',request=>{
    if(request.method()==='POST')writes.push(new URL(request.url()).pathname);
  });
  return writes;
}

async function noWork(request:APIRequestContext,projectId:string):Promise<void> {
  for(const [path,key] of [['work','work'],['annotations','annotations']] as const){
    const response=await request.get(`/api/${path}?projectId=${projectId}`);
    expect(response.ok()).toBe(true);
    expect((await response.json() as Record<string,unknown[]>)[key]).toEqual([]);
  }
  const response=await request.get('/api/connections');
  expect(response.ok()).toBe(true);
  const {connections}=await response.json() as {connections:AgentConnection[]};
  expect(connections.map(value=>value.id).sort()).toEqual(['chatgpt','codex']);
  for(const connection of connections){expect(connection.state).toBe('unavailable');expect(connection.capabilities).toEqual([]);}
}

test.beforeEach(async({request})=>{
  await post(request,'/api/workspace/access',{mode:'all_connected',selectedProjectIds:[]});
});

for(const mode of ['absent','partial'] as const){
  test(`a ${mode} host API remains unavailable and never queues work`,async({page,request})=>{
    await installHost(page,mode);
    const data=await scenario(request),dialog=await openComposer(page,data);
    const area=handoff(dialog),writes=recordWrites(page);
    await expect(area).toContainText(/unavailable|unsupported/i);
    await expect(area.getByRole('button',{name:'Open host annotation',exact:true})).toBeDisabled();
    expect(await calls(page)).toEqual([]);
    expect(writes).toEqual([]);
    await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(fullAnnotation);
    await noWork(request,data.project.id);
  });
}

test('explicit handoff captures only the six visible references and exact separate comment with no durable side effects',async({page,request})=>{
  await installHost(page);
  const data=await scenario(request),dialog=await openComposer(page,data);
  const area=handoff(dialog),writes=recordWrites(page);
  const material=dialog.getByRole('region',{name:'Selected material',exact:true});
  await material.getByText('Exact selected JSON',{exact:true}).click();
  await expect(material).toContainText(fullAnnotation);
  await expect(material).toContainText(selectedDescription);
  await expect(material).toContainText(selectedRule);
  await dialog.getByRole('combobox',{name:'Target',exact:true}).selectOption('codex');
  const action=await approve(dialog);
  await expect(area).toContainText(/host may include page context/i);
  await expect(area).toContainText(/cannot choose the conversation or confirm delivery/i);
  await expect(area.getByRole('region',{name:'Host reference preview',exact:true})).toContainText(shortComment);
  expect(await calls(page)).toEqual([]);
  await action.click();
  await expect(area.getByRole('status')).toHaveText('Handoff request accepted; delivery is not confirmed.');
  const captured=await calls(page);
  expect(captured).toHaveLength(1);
  const call=captured[0];
  expect(call).toMatchObject({connected:true,visible:true,initialComment:shortComment,omitScreenshot:true,
    metadata:{projectId:data.project.id,itemId:null,workflowId:data.workflow.id,stepId:'review',specRevision:1,mapRevision:data.project.mapRevision}});
  expect(Object.keys(call.metadata)).toEqual(['projectId','itemId','workflowId','stepId','specRevision','mapRevision']);
  for(const value of Object.values(call.metadata))expect(call.text).toContain(String(value));
  expect(call.text).toContain(shortComment);
  for(const marker of [fullAnnotation,selectedDescription,selectedRule,data.project.name,data.workflow.name,'schemaVersion','materialJSON']){
    expect(call.html).not.toContain(marker);
  }
  expect(call.html).not.toMatch(/<input|<textarea|<button|<pre|<script/i);
  expect(writes).toEqual([]);
  await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(fullAnnotation);
  await expect(dialog.getByRole('combobox',{name:'Target',exact:true})).toHaveValue('codex');
  await expect(dialog.getByRole('combobox',{name:'Send mode',exact:true})).toHaveValue('local');
  await noWork(request,data.project.id);
});

for(const mode of ['refused','throw'] as const){
  test(`a ${mode} request reports no confirmed handoff and does not retry or queue`,async({page,request})=>{
    await installHost(page,mode);
    const data=await scenario(request),dialog=await openComposer(page,data);
    const writes=recordWrites(page);
    await (await approve(dialog)).click();
    await expect(handoff(dialog).getByRole('status')).toContainText(/not accepted|not confirmed|could not/i);
    expect(await calls(page)).toHaveLength(1);
    await page.evaluate(()=>{
      document.dispatchEvent(new Event('oaiannotationmodechange'));
      document.dispatchEvent(new Event('oaiannotationcontrolchange'));
      window.dispatchEvent(new Event('online'));
    });
    expect(await calls(page)).toHaveLength(1);
    expect(writes).toEqual([]);
    await noWork(request,data.project.id);
  });
}

test('consent is separate, resets on each draft change, and an accepted target is replaced rather than mutated',async({page,request})=>{
  await installHost(page);
  const data=await scenario(request),dialog=await openComposer(page,data);
  const area=handoff(dialog),checkbox=area.getByRole('checkbox',{name:approval,exact:true});
  await dialog.getByRole('combobox',{name:'Send mode',exact:true}).selectOption('connected');
  const connected=dialog.getByRole('checkbox',{name:/I approve sending these selected details/});
  await connected.check();
  const action=area.getByRole('button',{name:'Open host annotation',exact:true});
  await expect(checkbox).not.toBeChecked();
  await expect(action).toBeDisabled();
  await (await approve(dialog)).click();
  await expect(connected).toBeChecked();
  await area.getByRole('textbox',{name:'Short host comment',exact:true}).fill('A different short comment.');
  await expect(checkbox).not.toBeChecked();
  await expect(action).toBeDisabled();
  await expect(area.getByRole('status')).toHaveCount(0);
  expect(await page.evaluate(()=>{
    const state=(window as HostWindow).__sovradHost;
    return {connected:state.targets[0].isConnected,text:state.targets[0].textContent};
  })).toEqual({connected:false,text:(await calls(page))[0].text});
  await checkbox.check();
  await dialog.getByRole('textbox',{name:'Annotation text',exact:true}).fill(fullAnnotation+' edited');
  await expect(checkbox).not.toBeChecked();
  await expect(connected).not.toBeChecked();
  await checkbox.check();
  await dialog.getByRole('combobox',{name:'Target',exact:true}).selectOption('chatgpt');
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await dialog.getByRole('combobox',{name:'Intent',exact:true}).selectOption('question');
  await expect(checkbox).not.toBeChecked();
  expect(await calls(page)).toHaveLength(1);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  expect(await page.evaluate(()=>(window as HostWindow).__sovradHost.targets.every(target=>!target.isConnected))).toBe(true);
  await page.getByRole('button',{name:'Back to project',exact:true}).click();
  await page.getByRole('button',{name:'Annotate project',exact:true}).click();
  const reopened=page.getByRole('dialog',{name:'Annotate selected context',exact:true});
  await expect(handoff(reopened).getByRole('checkbox',{name:approval,exact:true})).not.toBeChecked();
  await expect(handoff(reopened).getByRole('textbox',{name:'Short host comment',exact:true})).toHaveValue('');
  expect(await calls(page)).toHaveLength(1);
  await noWork(request,data.project.id);
});

test('changed selected context and denied refresh clear consent and never make an automatic handoff',async({page,request})=>{
  await installHost(page);
  const data=await scenario(request),dialog=await openComposer(page,data,false);
  const area=handoff(dialog),checkbox=area.getByRole('checkbox',{name:approval,exact:true});
  await approve(dialog);
  await post(request,`/api/projects/${data.project.id}/workflows`,{
    clientRequestId:crypto.randomUUID(),expectedMapRevision:data.project.mapRevision,itemId:null,
    name:'Another fictional map',description:'Changes the selected map revision.',steps:data.workflow.steps,connections:[],
  });
  await expect(checkbox).not.toBeChecked({timeout:12000});
  await expect(area.getByRole('button',{name:'Open host annotation',exact:true})).toBeDisabled();
  await checkbox.check();
  await page.route(`**/api/projects/${data.project.id}/overview**`,route=>route.fulfill({status:403,json:{error:'Selected context unavailable.'}}));
  await expect(area.getByRole('button',{name:'Open host annotation',exact:true})).toBeDisabled({timeout:12000});
  expect(await calls(page)).toEqual([]);
  await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(fullAnnotation);
  await noWork(request,data.project.id);
});

test('credential-like raw, quoted and escaped short comments are refused without echo or outbound calls',async({page,request})=>{
  await installHost(page);
  const data=await scenario(request),dialog=await openComposer(page,data);
  const area=handoff(dialog),input=area.getByRole('textbox',{name:'Short host comment',exact:true});
  const markers=['sk-'+('FAKE_SYNTHETIC_'.repeat(3)),'password=FictionalCredentialMarker123',
    '"api_key":"FictionalCredentialMarker123"','\\"access_token\\":\\"FictionalCredentialMarker123\\"'];
  const writes=recordWrites(page);
  for(const marker of markers){
    await input.fill(marker);
    await expect(area.getByRole('button',{name:'Open host annotation',exact:true})).toBeDisabled();
    const alerts=await area.getByRole('alert').allTextContents();
    expect(alerts.join(' ')).toMatch(/credential|private|sensitive/i);
    expect(alerts.join(' ')).not.toContain(marker);
    expect(await calls(page)).toEqual([]);
  }
  await (await approve(dialog,'Clean fictional reference question.')).click();
  expect(await calls(page)).toHaveLength(1);
  expect(writes).toEqual([]);
  await noWork(request,data.project.id);
});

test('short comment bounds count UTF-16 units and refuse oversized input without truncation',async({page,request})=>{
  await installHost(page);
  const data=await scenario(request),dialog=await openComposer(page,data);
  const area=handoff(dialog),input=area.getByRole('textbox',{name:'Short host comment',exact:true});
  const boundary='🧭'.repeat(120);
  expect(boundary.length).toBe(240);
  await (await approve(dialog,boundary)).click();
  expect((await calls(page))[0].initialComment).toBe(boundary);
  // Simulate a programmatic input path so maxlength cannot substitute for action validation.
  await input.evaluate((element,value)=>{
    element.removeAttribute('maxlength');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(element,value);
    element.dispatchEvent(new Event('input',{bubbles:true}));
  },boundary+'x');
  await expect(input).toHaveValue(boundary+'x');
  await expect(area.getByRole('button',{name:'Open host annotation',exact:true})).toBeDisabled();
  await expect(area.getByRole('alert')).toContainText(/240|too long|limit/i);
  expect(await calls(page)).toHaveLength(1);
  await noWork(request,data.project.id);
});

for(const mutation of ['hidden','detached','shadow'] as const){
  test(`a ${mutation} reviewed preview cannot be handed off`,async({page,request})=>{
    await installHost(page);
    const data=await scenario(request),dialog=await openComposer(page,data);
    const action=await approve(dialog);
    await handoff(dialog).getByRole('region',{name:'Host reference preview',exact:true}).evaluate((element,mutation)=>{
      if(mutation==='hidden')(element as HTMLElement).style.display='none';
      else if(mutation==='detached')element.remove();
      else{
        const container=document.createElement('div');
        element.parentElement!.append(container);
        container.attachShadow({mode:'open'}).append(element);
      }
    },mutation);
    await action.click();
    await expect(handoff(dialog).getByRole('status')).toContainText(/not accepted|not confirmed|could not|unavailable|changed|visible/i);
    expect(await calls(page)).toEqual([]);
    await expect(dialog.getByRole('textbox',{name:'Annotation text',exact:true})).toHaveValue(fullAnnotation);
    await noWork(request,data.project.id);
  });
}
