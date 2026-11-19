import type {APIRequestContext} from '@playwright/test';
import type {OverviewResponse, RegisteredProject, WorkDetailResponse} from '@renvarel/architect-core';
import {test, expect, createProject} from './fixtures';

async function assertCompleteSeed(request:APIRequestContext,project:RegisteredProject):Promise<void> {
  const items:string[]=[],workflows:string[]=[];
  let cursor:string|null=null;
  do {
    const query=cursor?`?cursor=${encodeURIComponent(cursor)}`:'';
    const response=await request.get(`/api/projects/${project.id}/overview${query}`);
    expect(response.status()).toBe(200);
    const overview:OverviewResponse=await response.json();
    expect(overview.project.id).toBe(project.id);
    expect(overview.totals).toMatchObject({items:103,workflows:107});
    expect(overview.items.length).toBeGreaterThan(0);
    expect(overview.workflows.length).toBeGreaterThan(0);
    expect(overview.items.every(item=>item.projectId===project.id)).toBe(true);
    expect(overview.workflows.every(workflow=>workflow.projectId===project.id)).toBe(true);
    items.push(...overview.items.map(item=>item.id));
    workflows.push(...overview.workflows.map(workflow=>workflow.id));
    cursor=overview.page.nextCursor;
  } while(cursor);
  expect(items).toHaveLength(103);
  expect(new Set(items).size).toBe(103);
  expect(workflows).toHaveLength(107);
  expect(new Set(workflows).size).toBe(107);
  expect(items).toContain(`${project.id}-item-102`);
  expect(workflows).toContain(`${project.id}-map-106`);
}

test.describe.serial('experience mode ends at the test boundary',()=>{
  let syntheticWorkId:string;
  let ordinaryProject:RegisteredProject;

  test('primer serves genuinely verified synthetic work and preserves it through an in-test restart',async({request,servers})=>{
    ordinaryProject=await createProject(request,'Fictional default-mode isolation control');
    const fixture=await servers.startExperience();
    syntheticWorkId=fixture.workIds.verified;
    const before=await request.get(`/api/work/${syntheticWorkId}`);
    expect(before.status()).toBe(200);
    const detail:WorkDetailResponse=await before.json();
    expect(detail.work.id).toBe(syntheticWorkId);
    expect(detail.work.state).toBe('done');
    expect(detail.verification).toBe('verified');
    expect(detail.evidence.length).toBeGreaterThan(0);
    expect(detail.evidence.some(row=>row.sourceClass==='test_runtime'&&row.outcome==='passed')).toBe(true);
    await servers.restartAPI();
    const after=await request.get(`/api/work/${syntheticWorkId}`);
    expect(after.status()).toBe(200);
    const restarted:WorkDetailResponse=await after.json();
    expect(restarted.work.id).toBe(syntheticWorkId);
    expect(restarted.verification).toBe('verified');
    expect(restarted.annotation).toEqual(detail.annotation);
  });

  test('the next ordinary test cannot read previous synthetic work and seeds its own active database',async({request,servers})=>{
    expect(syntheticWorkId).toBeTruthy();
    expect((await request.get(`/api/work/${syntheticWorkId}`)).status()).toBe(404);
    const restored=await request.get(`/api/projects/${ordinaryProject.id}/overview`);
    expect(restored.status()).toBe(200);
    expect((await restored.json()).project).toMatchObject({id:ordinaryProject.id,name:ordinaryProject.name});
    const project=await createProject(request,'Fictional ordinary seeded isolation map');
    servers.seedComplete(project);
    await assertCompleteSeed(request,project);
  });
});

test('seedComplete populates the database served by an explicitly started experience API',async({request,servers})=>{
  const fixture=await servers.startExperience();
  const verified=await request.get(`/api/work/${fixture.workIds.verified}`);
  expect(verified.status()).toBe(200);
  expect((await verified.json()).verification).toBe('verified');
  const project=await createProject(request,'Fictional experience seeded isolation map');
  const empty=await request.get(`/api/projects/${project.id}/overview`);
  expect(empty.status()).toBe(200);
  expect((await empty.json()).totals).toMatchObject({items:0,workflows:0});
  servers.seedComplete(project);
  await assertCompleteSeed(request,project);
});
