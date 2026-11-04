import {test, expect, createProject, post, actionHeaders} from './fixtures';
import type {OverviewResponse, RegisteredProject, WorkspaceResponse} from '@renvarel/architect-core';

test.beforeEach(async ({request}) => {
  await post(request,'/api/workspace/access',{mode:'all_connected',selectedProjectIds:[]});
});

test('create planning project, items and workflow; rename keeps the selected stable context', async ({page}) => {
  const errors:string[] = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button',{name:'Add project',exact:true}).click();
  await page.getByLabel('Project name',{exact:true}).fill('Fictional planning desk');
  await page.getByLabel('Project description',{exact:true}).fill('Plan a fictional intake process.');
  await page.getByRole('button',{name:'Create project',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Fictional planning desk',exact:true})).toBeVisible();
  await expect(page.getByText('Planning only',{exact:true}).first()).toBeVisible();
  await expect(page.getByText('Source unmapped',{exact:true}).first()).toBeVisible();
  await page.getByRole('button',{name:'Add item',exact:true}).click();
  await page.getByLabel('Item name',{exact:true}).fill('Intake');
  await page.getByLabel('Item description',{exact:true}).fill('Review a fictional request.');
  await page.getByRole('button',{name:'Create item',exact:true}).click();
  const item = page.locator('[data-item-id]').filter({hasText:'Intake'});
  const stableID = await item.getAttribute('data-item-id');
  await item.getByRole('button',{name:'Edit item',exact:true}).click();
  await page.getByLabel('Item name',{exact:true}).fill('Request intake');
  await page.getByRole('button',{name:'Save item',exact:true}).click();
  await expect(page.locator(`[data-item-id="${stableID}"]`)).toContainText('Request intake');
  await page.locator(`[data-item-id="${stableID}"]`).getByRole('button',{name:'Create workflow',exact:true}).click();
  await page.getByLabel('Workflow name',{exact:true}).fill('Fictional intake map');
  await page.getByLabel('Steps (one per line)',{exact:true}).fill('Receive request\nReview request');
  await page.getByRole('dialog',{name:'Add workflow',exact:true}).getByRole('button',{name:'Create workflow',exact:true}).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(page.getByRole('heading',{name:'Receive request',exact:true})).toBeVisible();
  await expect(page.locator('.inspector')).toContainText('Not yet checked');
  await expect(page.getByRole('button',{name:/Edit (connections|topology)/i})).toHaveCount(0);
  await page.getByLabel('What should change?',{exact:true}).fill('Retain the draft through an item rename.');
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.locator(`[data-item-id="${stableID}"]`).getByRole('button',{name:'Edit item',exact:true}).click();
  await page.getByLabel('Item name',{exact:true}).fill('Reviewed intake');
  await page.getByRole('button',{name:'Save item',exact:true}).click();
  await page.locator(`[data-item-id="${stableID}"]`).getByRole('button',{name:'Open workflow',exact:true}).click();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Retain the draft through an item rename.');
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByLabel('Development filter',{exact:true}).selectOption('future');
  await expect(page.getByText('Showing 0 of 0 items / 0 of 0 workflows',{exact:true})).toBeVisible();
  await page.getByLabel('Development filter',{exact:true}).selectOption('planning');
  await expect(page.getByText('Showing 1 of 1 items / 1 of 1 workflows',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('complete project list loads beyond100 without losing selection or drafts', async ({page,request,servers}) => {
  const project = await createProject(request,'Complete fictional map');
  servers.seedComplete(project);
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:project.name,exact:true}).click();
  await expect(page.getByText('Showing 50 of 103 items / 50 of 107 workflows',{exact:true})).toBeVisible();
  await expect(page.getByText('Complete list loaded',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Open Matching map 0',exact:true}).click();
  await page.getByLabel('What should change?',{exact:true}).fill('Keep this unsent context draft.');
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(page.getByText('Showing 100 of 103 items / 100 of 107 workflows',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Load all',exact:true}).click();
  await expect(page.getByText('Showing 103 of 103 items / 107 of 107 workflows',{exact:true})).toBeVisible();
  await expect(page.getByText('Complete list loaded',{exact:true})).toBeVisible();
  const first = page.locator(`[data-item-id="${project.id}-item-000"]`);
  await expect(first).toContainText('Parent: Matching item 102');
  await expect(first).toContainText('Depends on: Matching item 102');
  await page.getByRole('button',{name:'Open Matching map 0',exact:true}).click();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep this unsent context draft.');
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByLabel('Search project',{exact:true}).fill('Matching item 0');
  await expect(page.getByText('Showing 1 of 1 items / 0 of 0 workflows',{exact:true})).toBeVisible();
  await page.getByLabel('Search project',{exact:true}).fill('');
  await expect(page.getByText('Showing 50 of 103 items / 50 of 107 workflows',{exact:true})).toBeVisible();
  // A real map edit invalidates the opaque server cursor, independently of UI logic.
  const overview:OverviewResponse = await (await request.get(`/api/projects/${project.id}/overview`)).json();
  await post(request,`/api/projects/${project.id}/items/${project.id}-item-000`,{
    expectedMapRevision:overview.project.mapRevision,name:'Renamed matching item',description:'Synthetic item.',development:'planning',
  });
  await page.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(page.getByText('This list changed. Refreshed from the beginning.',{exact:true})).toBeVisible();
  await expect(page.getByText('Showing 50 of 103 items / 50 of 107 workflows',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Matching map 0',exact:true}).click();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep this unsent context draft.');
});

test('failed, cancelled and late page loads stay incomplete and cannot append to another filter', async ({page,request,servers}) => {
  const project = await createProject(request,'Interrupted fictional map');
  servers.seedComplete(project);
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:project.name,exact:true}).click();
  await expect(page.getByText('Showing 50 of 103 items / 50 of 107 workflows',{exact:true})).toBeVisible();
  await page.route(`**/projects/${project.id}/overview?*`,async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('cursor')) await route.fulfill({status:503,json:{error:'Synthetic page interruption.'}});
    else await route.continue();
  });
  await page.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic page interruption.');
  await expect(page.getByText('Complete list loaded',{exact:true})).toHaveCount(0);
  await page.unroute(`**/projects/${project.id}/overview?*`);
  await page.getByRole('button',{name:'Retry loading',exact:true}).click();
  await expect(page.getByText('Showing 100 of 103 items / 100 of 107 workflows',{exact:true})).toBeVisible();
  let release:()=>void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let started:()=>void = () => {};
  const pending = new Promise<void>(resolve => { started = resolve; });
  let finished:()=>void = () => {};
  const released = new Promise<void>(resolve => { finished = resolve; });
  let lateStatus:number|undefined;
  await page.route(`**/projects/${project.id}/overview?*`,async route => {
    if (new URL(route.request().url()).searchParams.has('cursor')) {
      started(); await held;
      try {
        const response=await route.fetch();lateStatus=response.status();
        await route.fulfill({response}).catch(()=>{});
      } finally { finished(); }
    } else await route.continue();
  });
  await page.getByRole('button',{name:'Load all',exact:true}).click();
  await pending;
  await page.getByRole('button',{name:'Cancel loading',exact:true}).click();
  await expect(page.getByText('Loading stopped. This list is incomplete.',{exact:true})).toBeVisible();
  await page.getByLabel('Development filter',{exact:true}).selectOption('future');
  await expect(page.getByText('Showing 0 of 0 items / 0 of 0 workflows',{exact:true})).toBeVisible();
  release();
  await released;
  expect(lateStatus).toBe(200);
  await expect(page.getByText('Showing 0 of 0 items / 0 of 0 workflows',{exact:true})).toBeVisible();
  await expect(page.locator('[data-item-id]')).toHaveCount(0);
});

test('review: workflow context survives nonaligned item pages and filters with draft selection and viewport', async ({page,request,servers}) => {
  const project=await createProject(request,'Nonaligned fictional map');
  servers.seedComplete(project,true);
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:project.name,exact:true}).click();
  await expect(page.getByText('Showing 50 of 103 items / 50 of 107 workflows',{exact:true})).toBeVisible();
  await expect(page.locator(`[data-item-id="${project.id}-item-102"]`)).toHaveCount(0);
  await page.getByRole('button',{name:'Open Matching map 0',exact:true}).click();
  await page.locator('.react-flow__node').filter({hasText:'Check 0'}).click();
  await page.getByLabel('What should change?',{exact:true}).fill('Keep the cross-page item context draft.');
  await page.locator('.react-flow__controls-zoomin').click();
  const viewport=await page.locator('.react-flow__viewport').getAttribute('style');
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Load all',exact:true}).click();
  await expect(page.getByText('Showing 103 of 103 items / 107 of 107 workflows',{exact:true})).toBeVisible();
  await expect(page.locator(`[data-item-id="${project.id}-item-102"]`)).toContainText('Matching item 102');
  await page.getByRole('button',{name:'Open Matching map 1',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review 1',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Open Matching map 0',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Check 0',exact:true})).toBeVisible();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep the cross-page item context draft.');
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style',viewport!);
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByLabel('Search project',{exact:true}).fill('Matching map 0');
  await expect(page.getByText('Showing 0 of 0 items / 1 of 1 workflows',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Matching map 0',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Check 0',exact:true})).toBeVisible();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep the cross-page item context draft.');
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style',viewport!);
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByLabel('Search project',{exact:true}).fill('');
  await expect(page.getByText('Showing 50 of 103 items / 50 of 107 workflows',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Load all',exact:true}).click();
  await expect(page.getByText('Showing 103 of 103 items / 107 of 107 workflows',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Matching map 0',exact:true}).click();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep the cross-page item context draft.');
  await expect(page.getByRole('heading',{name:'Check 0',exact:true})).toBeVisible();
  // An explicit item entry is a separate material context, even for the same map.
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.locator(`[data-item-id="${project.id}-item-102"]`).getByRole('button',{name:'Open workflow',exact:true}).click();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('');
  await page.getByLabel('What should change?',{exact:true}).fill('Keep this separately selected item draft.');
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Open Matching map 0',exact:true}).click();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep the cross-page item context draft.');
  await expect(page.getByRole('heading',{name:'Check 0',exact:true})).toBeVisible();
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style',viewport!);
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.locator(`[data-item-id="${project.id}-item-102"]`).getByRole('button',{name:'Open workflow',exact:true}).click();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep this separately selected item draft.');
});

test('review: natural search typing keeps focus and remains editable after a failed page', async ({page,request,servers}) => {
  const project=await createProject(request,'Keyboard fictional map');servers.seedComplete(project);
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:project.name,exact:true}).click();
  const search=page.getByLabel('Search project',{exact:true});
  await expect(search).toBeVisible();
  await page.route(`**/projects/${project.id}/overview?*`,async route=>{
    const response=await route.fetch();
    await new Promise(resolve=>setTimeout(resolve,150));
    await route.fulfill({response}).catch(()=>{});
  });
  await search.focus();
  await search.pressSequentially('Matching',{delay:40});
  await expect(search).toHaveValue('Matching');
  await expect(search).toBeFocused();
  await expect(page.getByText('Showing 50 of 103 items / 50 of 107 workflows',{exact:true})).toBeVisible();
  await expect(search).toBeFocused();
  await page.unroute(`**/projects/${project.id}/overview?*`);
  await page.route(`**/projects/${project.id}/overview?*`,route=>route.fulfill({status:503,json:{error:'Synthetic search unavailable.'}}));
  await search.pressSequentially(' missing',{delay:20});
  await expect(search).toHaveValue('Matching missing');
  await expect(page.getByRole('alert')).toContainText('Synthetic search unavailable.');
  await expect(search).toBeFocused();
  await page.unroute(`**/projects/${project.id}/overview?*`);
  await search.press('ControlOrMeta+A');
  await search.press('Backspace');
  await search.pressSequentially('Matching item 0',{delay:20});
  await expect(search).toHaveValue('Matching item 0');
  await expect(page.getByText('Showing 1 of 1 items / 0 of 0 workflows',{exact:true})).toBeVisible();
  await expect(search).toBeFocused();
});

test('review: item name search opens its linked workflow directly without a matching workflow summary', async ({page,request,servers}) => {
  const project=await createProject(request,'Item entry fictional map');servers.seedComplete(project,true);
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:project.name,exact:true}).click();
  await page.getByLabel('Search project',{exact:true}).fill('Matching item 102');
  await expect(page.getByText('Showing 1 of 1 items / 0 of 0 workflows',{exact:true})).toBeVisible();
  const item=page.locator(`[data-item-id="${project.id}-item-102"]`);
  await item.getByRole('button',{name:'Open workflow',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review 0',exact:true})).toBeVisible();
  await page.getByLabel('What should change?',{exact:true}).fill('Keep the explicit item draft.');
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await item.getByRole('button',{name:'Open workflow',exact:true}).click();
  await expect(page.getByLabel('What should change?',{exact:true})).toHaveValue('Keep the explicit item draft.');
});

test('review: cancelling the initial management load stays incomplete and can retry in place', async ({page}) => {
  await page.goto('/');
  let started:()=>void=()=>{};
  const pending=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/api/workspace?management=true*',async route=>{started(); /* Remains held until explicitly aborted by Cancel. */});
  await page.getByRole('button',{name:'Manage projects',exact:true}).click();
  const manager=page.getByRole('dialog',{name:'Manage projects',exact:true});
  await pending;
  await manager.getByRole('button',{name:'Cancel loading',exact:true}).click();
  await expect(manager).toContainText('Loading stopped. This list is incomplete.');
  await expect(manager.getByText('All registered choices loaded',{exact:true})).toHaveCount(0);
  await expect(manager.getByRole('button',{name:'Retry loading',exact:true})).toBeVisible();
  await page.unroute('**/api/workspace?management=true*');
  await manager.getByRole('button',{name:'Retry loading',exact:true}).click();
  await expect(manager.locator('[data-project-id]')).not.toHaveCount(0);
  await expect(manager.getByRole('button',{name:'Save access',exact:true})).toBeEnabled();
});

test('review: saving first-page access preserves a selected ID absent from loaded management choices', async ({page,request}) => {
  const entries:RegisteredProject[]=[];
  for(let index=0;index<103;index++)entries.push(await createProject(request,`Unloaded choice ${index}`));
  const retained=[...entries].sort((a,b)=>a.id<b.id?-1:1).at(-1)!;
  await post(request,'/api/workspace/access',{mode:'selected',selectedProjectIds:['sample-calculator',retained.id]});
  await page.goto('/');
  await page.getByRole('button',{name:'Manage projects',exact:true}).click();
  const manager=page.getByRole('dialog',{name:'Manage projects',exact:true});
  await expect(manager.locator('[data-project-id]')).toHaveCount(50);
  await expect(manager.locator(`[data-project-id="${retained.id}"]`)).toHaveCount(0);
  const first=manager.locator('[data-project-id]').first();
  const addedID=await first.getAttribute('data-project-id');
  await first.getByRole('checkbox').check();
  await manager.getByRole('button',{name:'Save access',exact:true}).click();
  await expect(manager.getByText('Project access saved. Grants did not change.',{exact:true})).toBeVisible();
  const workspace:WorkspaceResponse=await (await request.get('/api/workspace')).json();
  expect(workspace.access.selectedProjectIds).toContain(retained.id);
  expect(workspace.access.selectedProjectIds).toContain(addedID);
  await expect(manager.locator(`[data-project-id="${retained.id}"]`)).toHaveCount(0);
});

for (const width of [1440,390]) {
  test(`Manage Projects can select and restore registered hidden projects at ${width}px`, async ({page,request}) => {
    const entries:RegisteredProject[] = [];
    for (let index=0; index<103; index++) entries.push(await createProject(request,`Registered fictional ${width}-${index}`));
    const target = [...entries].sort((a,b) => a.id < b.id ? -1 : 1).at(-1)!;
    const retained = [...entries].sort((a,b) => a.id < b.id ? -1 : 1).at(-2)!;
    const archived = (await post<{project:RegisteredProject}>(request,`/api/projects/${target.id}/settings`,{expectedGrantRevision:1,archived:true})).project;
    await post(request,'/api/workspace/access',{mode:'selected',selectedProjectIds:['sample-calculator',retained.id]});
    const attemptedHiddenReads:string[] = [];
    const writes:{url:string;body:unknown}[] = [];
    page.on('request',req => {
      if (req.method()==='POST') writes.push({url:req.url(),body:req.postDataJSON()});
      if (req.method()==='GET' && req.url().includes(`/projects/${target.id}/`) && !req.url().includes('settings')) attemptedHiddenReads.push(req.url());
    });
    await page.setViewportSize({width,height:1000});
    await page.goto('/');
    await page.getByRole('button',{name:'Manage projects',exact:true}).click();
    const manager = page.getByRole('dialog',{name:'Manage projects',exact:true});
    await expect(manager).toContainText('Registered in Sovrad');
    await expect(manager.getByText(target.name,{exact:true})).toHaveCount(0);
    await manager.getByRole('button',{name:'Load all',exact:true}).click();
    const row = manager.locator(`[data-project-id="${target.id}"]`);
    await expect(row.getByText(target.name,{exact:true})).toBeVisible();
    await expect(row).toContainText('Archived');
    await expect(row).toContainText('Not selected');
    await expect(row.getByRole('button',{name:'Restore',exact:true})).toBeDisabled();
    expect(attemptedHiddenReads).toEqual([]);
    await row.getByRole('checkbox').check();
    await manager.getByRole('button',{name:'Save access',exact:true}).click();
    await expect(row.getByRole('button',{name:'Restore',exact:true})).toBeEnabled();
    // A failed explicit restore stays visibly archived; selection never restores on its own.
    await page.route(`**/projects/${target.id}/settings`,route => route.fulfill({status:409,json:{error:'Synthetic stale restore.'}}));
    await row.getByRole('button',{name:'Restore',exact:true}).click();
    await expect(row).toContainText('Archived');
    await expect(manager.getByRole('alert')).toContainText('Synthetic stale restore.');
    await page.unroute(`**/projects/${target.id}/settings`);
    await row.getByRole('button',{name:'Restore',exact:true}).click();
    await expect(row.getByText('Archived',{exact:true})).toHaveCount(0);
    const restore = writes.filter(write => write.url.endsWith(`/projects/${target.id}/settings`)).at(-1);
    expect(restore?.body).toEqual({expectedGrantRevision:archived.grantRevision,archived:false});
    const workspace:WorkspaceResponse = await (await request.get('/api/workspace')).json();
    expect(workspace.access.selectedProjectIds).toContain(retained.id);
    expect(workspace.projects.find(p => p.id===target.id)?.grant).toBe(target.grant);
    expect(writes.some(write => /tasks|start|repositories/.test(write.url))).toBe(false);
    await expect(manager).not.toContainText('Fictional browser-test planning project.');
    await expect(page.getByText('All Codex projects',{exact:true})).toHaveCount(0);
    await manager.getByRole('button',{name:'Close',exact:true}).click();
    await expect(page.locator('.sidebar').getByRole('button',{name:target.name,exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Manage projects',exact:true}).click();
    await page.getByRole('radio',{name:'All connected projects',exact:true}).check();
    await page.getByRole('button',{name:'Save access',exact:true}).click();
    expect((await (await request.get('/api/workspace')).json()).access.mode).toBe('all_connected');
    expect(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}
