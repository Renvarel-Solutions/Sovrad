import {test as base, expect, type APIRequestContext} from '@playwright/test';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {RegisteredProject, ProjectItem, Workflow} from '@renvarel/architect-core';
import type {ExperienceCommand,ExperienceCommandResult,ExperienceFixtureEnvelope,ExperienceIPCResponse,ExperienceSnapshot} from './experience-contract.js';
export type {ExperienceCommand,ExperienceCommandResult,ExperienceFixtureEnvelope,ExperienceSnapshot} from './experience-contract.js';

export const root = path.resolve(import.meta.dirname, '../..');
export const actionHeaders = {'X-Sovrad-Action':'1', Origin:'http://127.0.0.1:5175'};
export async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const response = await request.post(url, {data, headers:actionHeaders});
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
export async function createProject(request: APIRequestContext, name: string): Promise<RegisteredProject> {
  return (await post<{project:RegisteredProject}>(request, '/api/projects', {
    clientRequestId:crypto.randomUUID(), name, description:'Fictional browser-test planning project.',
  })).project;
}

export class ScratchServers {
  readonly directory = mkdtempSync(path.join(os.tmpdir(), 'sovrad-browser-'));
  api: ChildProcess | undefined;
  private web: ChildProcess | undefined;
  private logs = '';
  private apiDirectory=this.directory;
  private experienceMode=false;
  private readonly ipcRequests=new Map<string,{resolve:(result:ExperienceCommandResult)=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>}>();
  private readonly profile = path.join(this.directory, 'empty-profile');
  private readonly env = {
    ...Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','CI']
      .flatMap(key => process.env[key] ? [[key,process.env[key]]] : [])),
    HOME:this.profile, USERPROFILE:this.profile, APPDATA:this.profile, LOCALAPPDATA:this.profile,
    CODEX_HOME:this.profile, SOVRAD_DATA_DIR:this.directory, SOVRAD_AI_ENABLED:'false',
    SOVRAD_AI_HARD_LIMIT_CONFIRMED:'false', OPENAI_API_KEY:'', WEB_PORT:'5175', API_PORT:'4319',
  };
  private launch(args: string[],experience=false): ChildProcess {
    const child = spawn(process.execPath,args,{cwd:root,env:{...this.env,SOVRAD_DATA_DIR:this.apiDirectory},stdio:experience?['ignore','pipe','pipe','ipc']:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout?.on('data',data => { this.logs += String(data); });
    child.stderr?.on('data',data => { this.logs += String(data); });
    if(experience){
      child.on('message',(message:ExperienceIPCResponse)=>{
        const pending=this.ipcRequests.get(message.id);if(!pending)return;
        clearTimeout(pending.timeout);this.ipcRequests.delete(message.id);
        if(message.ok)pending.resolve(message.result);else pending.reject(new Error(message.error));
      });
      child.once('exit',()=>{for(const pending of this.ipcRequests.values()){clearTimeout(pending.timeout);pending.reject(new Error('Owned synthetic API exited.'));}this.ipcRequests.clear();});
    }
    return child;
  }
  private async stop(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child,'exit');
    child.kill();
    await exited;
  }
  private async ready(url: string): Promise<void> {
    await expect.poll(async () => {
      try { return (await fetch(url)).ok; } catch { return false; }
    },{timeout:20000,message:'Scratch server did not start: '+this.logs}).toBe(true);
  }
  async start(): Promise<void> {
    for (const port of [4319,5175]) {
      const probe = createServer();
      await new Promise<void>((resolve,reject) => {
        probe.once('error',() => reject(new Error(`Scratch port ${port} is unavailable. E2E will not stop an existing process.`)));
        probe.listen(port,'127.0.0.1',() => probe.close(error => error ? reject(error) : resolve()));
      });
    }
    mkdirSync(this.profile,{recursive:true});
    this.api = this.launch(['--import','tsx',this.experienceMode?'tests/e2e/experience-fixture-server.ts':'apps/api/src/server.ts'],this.experienceMode);
    this.web = this.launch(['node_modules/vite/bin/vite.js','--config','apps/web/vite.config.ts','apps/web']);
    await this.ready('http://127.0.0.1:4319/api/health');
    await this.ready('http://127.0.0.1:5175');
  }
  async restartAPI(): Promise<{previousPID:number | undefined; nextPID:number | undefined}> {
    const previousPID = this.api?.pid;
    await this.stop(this.api);
    await expect.poll(async () => {
      try { await fetch('http://127.0.0.1:4319/api/health'); return true; } catch { return false; }
    }).toBe(false);
    this.api = this.launch(['--import','tsx',this.experienceMode?'tests/e2e/experience-fixture-server.ts':'apps/api/src/server.ts'],this.experienceMode);
    await this.ready('http://127.0.0.1:4319/api/health');
    return {previousPID,nextPID:this.api.pid};
  }
  async ensureDefaultMode():Promise<void> {
    if(!this.experienceMode)return;
    this.apiDirectory=this.directory;this.experienceMode=false;
    await this.restartAPI();
  }
  async startExperience():Promise<ExperienceFixtureEnvelope> {
    if(!this.web)await this.start();
    await this.stop(this.api);
    this.apiDirectory=mkdtempSync(path.join(this.directory,'experience-'));this.experienceMode=true;
    this.api=this.launch(['--import','tsx','tests/e2e/experience-fixture-server.ts'],true);
    await this.ready('http://127.0.0.1:4319/api/health');
    const snapshot=await this.experienceChange({kind:'snapshot'});
    if(snapshot.kind!=='snapshot')throw new Error('Invalid synthetic fixture readiness response.');
    if(snapshot.fixture.pendingTotal!==125||snapshot.workspace.pendingDecisionCount!==125)throw new Error('Synthetic decision baseline is incomplete.');
    return snapshot.fixture;
  }
  async experienceChange(input:{kind:'snapshot'}):Promise<ExperienceSnapshot>;
  async experienceChange(input:ExperienceCommand):Promise<ExperienceCommandResult>;
  async experienceChange(input:ExperienceCommand):Promise<ExperienceCommandResult> {
    const child=this.api;if(!this.experienceMode||!child?.connected)throw new Error('The owned synthetic experience API is not running.');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.ipcRequests.delete(id);reject(new Error('Synthetic fixture command timed out.'));},15_000);
      this.ipcRequests.set(id,{resolve,reject,timeout});
      child.send({id,command:input},error=>{if(error){clearTimeout(timeout);this.ipcRequests.delete(id);reject(new Error('Synthetic fixture command could not be sent.'));}});
    });
  }
  async close(): Promise<void> {
    await this.stop(this.web);
    await this.stop(this.api);
    rmSync(this.directory,{recursive:true,force:true});
  }
  seedComplete(project: RegisteredProject, crossPage = false): void {
    const db = new Database(path.join(this.apiDirectory,'sovrad.sqlite'));
    try {
      db.transaction(() => {
        for (let i = 106; i >= 0; i--) {
          const id = `${project.id}-map-${String(i).padStart(3,'0')}`;
          const workflow: Workflow = {id,projectId:project.id,name:`Matching map ${i}`,description:'Synthetic map.',revision:1,
            steps:[{id:'review',title:`Review ${i}`,kind:'process',purpose:'Review fictional input.',rules:['Keep the original input.'],
              inputs:['Fictional input'],outputs:['Reviewed input'],errorBehavior:'Explain a correction.',position:{x:0,y:0}}],connections:[]};
          if(crossPage&&i===0){
            workflow.steps.push({...workflow.steps[0],id:'check',title:'Check 0',position:{x:300,y:0}});
            workflow.connections.push({id:'review-check',source:'review',target:'check',label:'Continue'});
          }
          db.prepare('INSERT INTO workflows(id,project_id,revision,payload) VALUES (?,?,?,?)').run(id,project.id,1,JSON.stringify(workflow));
          db.prepare('INSERT INTO workflow_revisions(workflow_id,revision,payload) VALUES (?,?,?)').run(id,1,JSON.stringify(workflow));
        }
        for (let i = 102; i >= 0; i--) {
          const item: ProjectItem = {id:`${project.id}-item-${String(i).padStart(3,'0')}`,projectId:project.id,
            parentId:i === 0 ? `${project.id}-item-102` : null,kind:'workflow',name:`Matching item ${i}`,description:'Synthetic item.',
            development:'planning',workflowId:`${project.id}-map-${String(crossPage&&i===0?102:crossPage&&i===102?0:i).padStart(3,'0')}`};
          db.prepare('INSERT INTO project_items(id,project_id,parent_id,workflow_id,payload) VALUES (?,?,?,?,?)')
            .run(item.id,project.id,item.parentId,item.workflowId,JSON.stringify(item));
        }
        db.prepare('INSERT INTO project_dependencies(project_id,source_item_id,target_item_id) VALUES (?,?,?)')
          .run(project.id,`${project.id}-item-000`,`${project.id}-item-102`);
      })();
    } finally { db.close(); }
  }
}

export const test = base.extend<{defaultMode:void}, {servers:ScratchServers}>({
  defaultMode:[async ({servers},use) => {
    await servers.ensureDefaultMode();
    await use();
  },{auto:true}],
  servers:[async ({},use) => {
    const servers = new ScratchServers();
    try { await servers.start(); await use(servers); } finally { await servers.close(); }
  },{scope:'worker',auto:true}],
});
export {expect};
