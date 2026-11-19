import type {Readable,Writable} from 'node:stream';
import path from 'node:path';
import {CODEX_VERSION} from './index.js';

export type Transport = {input: Writable; output: Readable; close: () => void};
export type DiagnosticIdentity = {home: string; platformFamily: string; platformOs: string};
export type PermissionProfileSummary = {id: string; allowed: boolean; description?: string|null};
export type PermissionProfilePage = {data: PermissionProfileSummary[]; nextCursor?: string|null};
type Pending = {id: number; method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout};
type State = 'fresh'|'initializing'|'initialized'|'ready'|'closed';
const closedError=(): Error=>new Error('Codex protocol closed');
const record=(value: unknown): value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const own=(value: object,key: string): boolean=>Object.hasOwn(value,key);
const bounded=(value: unknown,max: number): value is string=>typeof value==='string'&&value.length<=max;

export function isDiagnosticIdentity(value: unknown): value is DiagnosticIdentity {
  return record(value)&&typeof value.home==='string'&&!value.home.includes('\0')&&path.win32.isAbsolute(value.home)&&
    value.platformFamily==='windows'&&value.platformOs==='windows';
}

export function diagnosticInitializeParams(): Record<string,unknown> {
  return {clientInfo:{name:'sovrad_preview',title:'Sovrad protocol probe',version:'0.1.0'},capabilities:{experimentalApi:true}};
}

function validParams(method: string,value: unknown): boolean {
  if(!record(value))return false;
  if(method==='initialize') {
    const info=value.clientInfo;const capabilities=value.capabilities;
    return Object.keys(value).length===2&&record(info)&&Object.keys(info).length===3&&info.name==='sovrad_preview'&&
      info.title==='Sovrad protocol probe'&&info.version==='0.1.0'&&record(capabilities)&&
      Object.keys(capabilities).length===1&&capabilities.experimentalApi===true;
  }
  return Object.keys(value).every(key=>['cwd','limit','cursor'].includes(key))&&
    typeof value.cwd==='string'&&!value.cwd.includes('\0')&&path.win32.isAbsolute(value.cwd)&&value.limit===50&&
    (!own(value,'cursor')||bounded(value.cursor,2048));
}

function initializeResult(value: unknown,identity: DiagnosticIdentity): Record<string,string> {
  if(!record(value)||typeof value.userAgent!=='string'||typeof value.codexHome!=='string'||
    typeof value.platformFamily!=='string'||typeof value.platformOs!=='string'||
    !path.win32.isAbsolute(value.codexHome)||path.win32.normalize(value.codexHome)!==path.win32.normalize(identity.home)||
    value.platformFamily!==identity.platformFamily||value.platformOs!==identity.platformOs||
    value.userAgent.match(/^[-A-Za-z0-9_.]+\/([^\s/]+)(?:\s.*)?$/)?.[1]!==CODEX_VERSION)throw closedError();
  return {userAgent:value.userAgent,codexHome:value.codexHome,platformFamily:value.platformFamily,platformOs:value.platformOs};
}

function profileResult(value: unknown): PermissionProfilePage {
  if(!record(value)||!Array.isArray(value.data)||value.data.length>50||
    (own(value,'nextCursor')&&value.nextCursor!==null&&!bounded(value.nextCursor,2048)))throw closedError();
  const data=value.data.map((profile: unknown): PermissionProfileSummary=>{
    if(!record(profile)||!bounded(profile.id,256)||typeof profile.allowed!=='boolean'||
      (own(profile,'description')&&profile.description!==null&&!bounded(profile.description,2048)))throw closedError();
    return {id:profile.id,allowed:profile.allowed,...(own(profile,'description')?{description:profile.description as string|null}:{})};
  });
  return {data,...(own(value,'nextCursor')?{nextCursor:value.nextCursor as string|null}:{})};
}

class Protocol {
  private nextId=1;
  private buffer='';
  private state: State='fresh';
  private pending: Pending|undefined;
  constructor(private readonly transport: Transport,private readonly identity: DiagnosticIdentity) {
    transport.output.setEncoding('utf8').on('data',chunk=>this.read(chunk));
    transport.output.on('end',()=>this.close()).on('close',()=>this.close()).on('error',()=>this.close());
    transport.input.on('close',()=>this.close()).on('error',()=>this.close());
  }
  private isClosed(): boolean {return this.state==='closed';}
  private send(message: unknown): boolean {
    if(this.state==='closed')return false;
    try {if(this.transport.input.write(JSON.stringify(message)+'\n'))return true;}catch {}
    this.close();return false;
  }
  private read(chunk: string): void {
    if(this.isClosed())return;
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>1024*1024){this.close();return;}
    while(this.buffer.includes('\n')&&!this.isClosed()) {
      const end=this.buffer.indexOf('\n');const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
      try {this.receive(JSON.parse(line));}catch {this.close();}
    }
  }
  private receive(message: unknown): void {
    if(!record(message))throw closedError();
    if(own(message,'method')) {
      if(typeof message.method!=='string'||!message.method||own(message,'result')||own(message,'error'))throw closedError();
      if(own(message,'id')) {
        if(!(bounded(message.id,256)||(typeof message.id==='number'&&Number.isSafeInteger(message.id))))throw closedError();
        this.deny(message.id,message.method);
      }
      return;
    }
    const pending=this.pending;
    if(typeof message.id!=='number'||!Number.isSafeInteger(message.id)||!pending||message.id!==pending.id||
      own(message,'result')===own(message,'error'))throw closedError();
    if(own(message,'error')) {
      if(!record(message.error)||!Number.isInteger(message.error.code)||typeof message.error.message!=='string')throw closedError();
      clearTimeout(pending.timer);this.pending=undefined;pending.reject(new Error('Codex protocol request failed'));this.close();return;
    }
    const result=pending.method==='initialize'?initializeResult(message.result,this.identity):profileResult(message.result);
    clearTimeout(pending.timer);this.pending=undefined;
    if(pending.method==='initialize')this.state='initialized';
    pending.resolve(result);
  }
  private deny(id: string|number,method: string): void {
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method))this.send({id,result:{decision:'decline'}});
    else if(method==='item/permissions/requestApproval')this.send({id,result:{permissions:{},scope:'turn'}});
    else this.send({id,error:{code:-32601,message:'Unsupported request; no permission granted'}});
  }
  async call(method: string,params: unknown): Promise<unknown> {
    if(!['initialize','permissionProfile/list'].includes(method))throw new Error('Coding methods are disabled');
    if(this.state==='closed')throw closedError();
    if(this.pending||(method==='initialize'?this.state!=='fresh':this.state!=='ready'))throw new Error('Codex protocol request is out of order');
    if(!validParams(method,params))throw new Error('Invalid diagnostic request');
    const id=this.nextId++;
    if(method==='initialize')this.state='initializing';
    return new Promise((resolve,reject)=>{
      this.pending={id,method,resolve,reject,timer:setTimeout(()=>this.close(),5000)};
      this.send({id,method,params});
    });
  }
  initialized(): void {
    if(this.state==='closed')throw closedError();
    if(this.state!=='initialized')throw new Error('Codex protocol request is out of order');
    if(!this.send({method:'initialized'})||this.isClosed())throw closedError();
    this.state='ready';
  }
  assertReady(): void {
    if(this.state!=='ready'||this.pending)throw closedError();
  }
  close(): void {
    if(this.state==='closed')return;
    this.state='closed';this.buffer='';
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(closedError());this.pending=undefined;}
    try {this.transport.close();}catch {}
  }
}

export function createProtocol(transport: Transport,identity: DiagnosticIdentity): Protocol {
  if(!isDiagnosticIdentity(identity)){try {transport.close();}catch {}throw closedError();}
  return new Protocol(transport,{...identity});
}
