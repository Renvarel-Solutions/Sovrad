import path from 'node:path';
import {CODEX_VERSION} from './index.js';
import {createProtocol,diagnosticInitializeParams,isDiagnosticIdentity} from './protocol.js';
import type {DiagnosticIdentity,PermissionProfilePage,PermissionProfileSummary,Transport} from './protocol.js';

export type DiagnosticOptions = DiagnosticIdentity&{cwd: string};
export type DiagnosticResult = {
  version: string; handshake: true; codingEnabled: false; ready: false; profiles: PermissionProfileSummary[];
};

// Transport-only policy discovery. Listed profiles establish no isolation or execution authority.
export async function diagnoseConnection(transport: Transport,options: DiagnosticOptions): Promise<DiagnosticResult> {
  let client: ReturnType<typeof createProtocol>|undefined;
  let deadline: NodeJS.Timeout|undefined;
  try {
    if(!isDiagnosticIdentity(options)||typeof options.cwd!=='string'||options.cwd.includes('\0')||!path.win32.isAbsolute(options.cwd))throw new Error();
    client=createProtocol(transport,options);
    deadline=setTimeout(()=>client?.close(),30000);
    await client.call('initialize',diagnosticInitializeParams());client.initialized();
    const profiles: PermissionProfileSummary[]=[];
    const identifiers=new Map<string,string>();const cursors=new Set<string>();
    let cursor: string|undefined;let records=0;
    for(let pageNumber=0;pageNumber<10;pageNumber++) {
      const page=await client.call('permissionProfile/list',{cwd:options.cwd,limit:50,...(cursor===undefined?{}:{cursor})}) as PermissionProfilePage;
      client.assertReady();
      records+=page.data.length;if(records>500)throw new Error();
      for(const profile of page.data) {
        const signature=JSON.stringify(profile);const prior=identifiers.get(profile.id);
        if(prior!==undefined&&prior!==signature)throw new Error();
        if(prior===undefined){identifiers.set(profile.id,signature);profiles.push(profile);}
      }
      if(page.nextCursor===undefined||page.nextCursor===null) {
        client.assertReady();
        return {version:CODEX_VERSION,handshake:true,codingEnabled:false,ready:false,profiles};
      }
      if(cursors.has(page.nextCursor))throw new Error();
      cursors.add(page.nextCursor);cursor=page.nextCursor;
    }
    throw new Error();
  } catch {throw new Error('Codex protocol closed');}
  finally {
    if(deadline)clearTimeout(deadline);
    if(client)client.close();else try {transport.close();}catch {}
  }
}
