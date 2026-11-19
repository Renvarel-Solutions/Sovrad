import type {Page} from '@playwright/test';
import type {AgentConnection, WorkDetailResponse} from '@renvarel/architect-core';
import {test, expect} from './fixtures';

async function connections(page:Page):Promise<AgentConnection[]> {
  const response=await page.request.get('/api/connections');expect(response.status()).toBe(200);
  return (await response.json() as {connections:AgentConnection[]}).connections;
}

async function work(page:Page,id:string):Promise<WorkDetailResponse> {
  const response=await page.request.get(`/api/work/${id}`);expect(response.status()).toBe(200);
  return response.json() as Promise<WorkDetailResponse>;
}

test('Codex and ChatGPT stay unavailable through real503 connect and local200 disconnect without reviving dependent work',async({page,servers})=>{
  const fixture=await servers.startExperience();
  const baseline=await connections(page);
  expect(baseline.map(value=>value.id).sort()).toEqual(['chatgpt','codex']);
  for(const value of baseline){
    expect(value.state).toBe('unavailable');expect(value.capabilities).toEqual([]);
    expect(value.lastSeenAt).toBeNull();expect(value.reason.trim().length).toBeGreaterThan(0);
  }
  const codexBefore=await work(page,fixture.workIds.connectionCodex);
  const automaticBefore=await work(page,fixture.workIds.connectionAutomatic);
  const chatgptBefore=await work(page,fixture.workIds.connectionChatgpt);
  expect(codexBefore.work.state).not.toBe('cancelled');expect(chatgptBefore.work.state).not.toBe('cancelled');
  const session=await page.request.get('/api/local-session');expect(session.status()).toBe(200);
  expect((await page.context().cookies()).some(value=>value.name==='sovrad_local_action'&&value.httpOnly)).toBe(true);
  await page.goto('/');
  await page.locator('.sidebar').getByRole('button',{name:'Workspace',exact:true}).click();
  const posted:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/connections\/[^/]+\/(connect|disconnect)$/.test(new URL(request.url()).pathname))posted.push(new URL(request.url()).pathname);});
  for(const entry of baseline){
    const label=entry.id==='codex'?'Codex':'ChatGPT';
    const panel=page.getByRole('region',{name:`${label} connection`,exact:true});
    await expect(panel).toContainText(/unavailable/i);await expect(panel).toContainText(entry.reason);
    await expect(panel.getByRole('progressbar')).toHaveCount(0);
    const responsePromise=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/connections/${entry.id}/connect`);
    await panel.getByRole('button',{name:`Connect ${label}`,exact:true}).click();
    const response=await responsePromise;expect(response.status()).toBe(503);
    const body=await response.json() as {code:string;connection:AgentConnection};
    expect(body.code).toBe('CONNECTION_UNAVAILABLE');expect(body.connection.state).toBe('unavailable');expect(body.connection.capabilities).toEqual([]);
    expect(response.request().postDataJSON()).toEqual({});
    await expect(panel).toContainText(/unavailable/i);await expect(panel).not.toContainText(/\bready\b|agent running|working now|sign.in complete/i);
  }
  const observedAt=Date.now();
  const poll=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/workspace'&&Date.now()-observedAt>=5000,{timeout:15000});
  await poll;expect(posted).toHaveLength(2);
  const disconnect=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/connections/codex/disconnect');
  await page.getByRole('region',{name:'Codex connection',exact:true}).getByRole('button',{name:'Disconnect Codex',exact:true}).click();
  expect((await disconnect).status()).toBe(200);
  const codexAfter=await work(page,fixture.workIds.connectionCodex),automaticAfter=await work(page,fixture.workIds.connectionAutomatic);
  for(const [before,after] of [[codexBefore,codexAfter],[automaticBefore,automaticAfter]]){
    expect(after.work.state).toBe('blocked');expect(after.work.version).toBeGreaterThan(before.work.version);
    expect(after.work.blockers.join(' ')).toMatch(/disconnect|revok/i);
    expect(after.annotation).toEqual(before.annotation);expect(after.events.length).toBeGreaterThan(before.events.length);
  }
  expect((await work(page,fixture.workIds.connectionChatgpt)).work).toEqual(chatgptBefore.work);
  const reconnect=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/connections/codex/connect');
  await page.getByRole('region',{name:'Codex connection',exact:true}).getByRole('button',{name:'Connect Codex',exact:true}).click();
  expect((await reconnect).status()).toBe(503);
  expect((await work(page,fixture.workIds.connectionCodex)).work).toEqual(codexAfter.work);
  expect((await work(page,fixture.workIds.connectionAutomatic)).work).toEqual(automaticAfter.work);
  const restart=await servers.restartAPI();expect(restart.nextPID).not.toBe(restart.previousPID);
  await page.reload();await page.locator('.sidebar').getByRole('button',{name:'Workspace',exact:true}).click();
  const persisted=await connections(page);expect(persisted).toEqual(baseline);
  expect((await work(page,fixture.workIds.connectionCodex)).work).toEqual(codexAfter.work);
  expect((await work(page,fixture.workIds.connectionChatgpt)).work).toEqual(chatgptBefore.work);
  for(const label of ['Codex','ChatGPT']){
    const panel=page.getByRole('region',{name:`${label} connection`,exact:true});
    await expect(panel).toContainText(/unavailable/i);await expect(panel.getByRole('progressbar')).toHaveCount(0);
  }
  expect(await page.evaluate(()=>document.cookie.includes('sovrad_local_action'))).toBe(false);
});
