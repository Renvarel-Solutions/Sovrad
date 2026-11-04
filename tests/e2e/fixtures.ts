import {test as base, expect, type APIRequestContext} from '@playwright/test';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {RegisteredProject, ProjectItem, Workflow} from '@renvarel/architect-core';

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
  private readonly profile = path.join(this.directory, 'empty-profile');
  private readonly env = {
    ...Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','CI']
      .flatMap(key => process.env[key] ? [[key,process.env[key]]] : [])),
    HOME:this.profile, USERPROFILE:this.profile, APPDATA:this.profile, LOCALAPPDATA:this.profile,
    CODEX_HOME:this.profile, SOVRAD_DATA_DIR:this.directory, SOVRAD_AI_ENABLED:'false',
    SOVRAD_AI_HARD_LIMIT_CONFIRMED:'false', OPENAI_API_KEY:'', WEB_PORT:'5175', API_PORT:'4319',
  };
  private launch(args: string[]): ChildProcess {
    const child = spawn(process.execPath,args,{cwd:root,env:this.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout?.on('data',data => { this.logs += String(data); });
    child.stderr?.on('data',data => { this.logs += String(data); });
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
    this.api = this.launch(['--import','tsx','apps/api/src/server.ts']);
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
    this.api = this.launch(['--import','tsx','apps/api/src/server.ts']);
    await this.ready('http://127.0.0.1:4319/api/health');
    return {previousPID,nextPID:this.api.pid};
  }
  async close(): Promise<void> {
    await this.stop(this.web);
    await this.stop(this.api);
    rmSync(this.directory,{recursive:true,force:true});
  }
  seedComplete(project: RegisteredProject, crossPage = false): void {
    const db = new Database(path.join(this.directory,'sovrad.sqlite'));
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

export const test = base.extend<{}, {servers:ScratchServers}>({
  servers:[async ({},use) => {
    const servers = new ScratchServers();
    try { await servers.start(); await use(servers); } finally { await servers.close(); }
  },{scope:'worker',auto:true}],
});
export {expect};
