import {spawn} from 'node:child_process';
import {mkdirSync,readdirSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {CODEX_VERSION} from './index.js';
import {createProtocol,diagnosticInitializeParams} from './protocol.js';

export async function probeAppServer(binary: string, home: string): Promise<{version:string;handshake:true;codingEnabled:false}> {
  if (!path.isAbsolute(binary)||!path.isAbsolute(home)) throw new Error('Explicit absolute probe paths required');
  // Conservative proposed Windows identity; its current live response formatting remains unproved.
  if (process.platform!=='win32') throw new Error('Untested diagnostic platform; coding remains disabled');
  mkdirSync(home,{recursive:true,mode:0o700});
  if (readdirSync(home).length) throw new Error('Probe requires an empty isolated configuration directory');
  home=realpathSync.native(home);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)));
  const child=spawn(binary,['app-server','--listen','stdio://','-c','analytics.enabled=false','-c','feedback.enabled=false'],{
    cwd:home,env:{...env,CODEX_HOME:home,HOME:home,USERPROFILE:home},stdio:['pipe','pipe','pipe'],windowsHide:true,
  });
  // Drain diagnostics without storing private paths, account data or raw provider output.
  child.stderr.resume();
  const client=createProtocol({input:child.stdin,output:child.stdout,close:()=>{child.kill();}},
    {home,platformFamily:'windows',platformOs:'windows'});
  child.once('error',()=>client.close());
  try {
    await client.call('initialize',diagnosticInitializeParams());
    client.initialized();
    return {version:CODEX_VERSION,handshake:true,codingEnabled:false};
  } finally {client.close();}
}
if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  void probeAppServer(process.argv[2],process.argv[3]).then(result=>console.log(JSON.stringify(result)))
    .catch(()=>{console.error('Isolated protocol probe failed; coding remains disabled.');process.exitCode=1;});
}
