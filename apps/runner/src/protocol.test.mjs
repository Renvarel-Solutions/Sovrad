import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import * as runner from './index.ts';

// Synthetic shapes from the 0.169.0-alpha.11.1 generated diagnostic contract.
const version='0.169.0-alpha.11.1';
const identity={home:'C:/synthetic-diagnostic-home',platformFamily:'windows',platformOs:'windows'};
const initializeParams={clientInfo:{name:'sovrad_preview',title:'Sovrad protocol probe',version:'0.1.0'},capabilities:{experimentalApi:true}};
const initializedResult={userAgent:`codex/${version}`,codexHome:identity.home,platformFamily:'windows',platformOs:'windows'};
const pageParams={cwd:'C:/synthetic-diagnostic-workspace',limit:50};
const closedError=error=>error instanceof Error&&error.message==='Codex protocol closed';
const unsupported={code:-32601,message:'Unsupported request; no permission granted'};

function fixture(t,options={}) {
  const output=new PassThrough();const sent=[];let closes=0;
  const input=new Writable({write(chunk,_encoding,done){sent.push(JSON.parse(String(chunk)));done();}});
  if(options.write)input.write=chunk=>{sent.push(JSON.parse(String(chunk)));return options.write();};
  const client=runner.createProtocol({input,output,close(){closes++;}},options.identity||identity);
  t.after(()=>client.close());
  return {client,input,output,sent,get closes(){return closes;},
    frame(message){output.write(JSON.stringify(message)+'\n');},
    reply(result){output.write(JSON.stringify({id:sent.at(-1).id,result})+'\n');}};
}

async function ready(f) {
  const pending=f.client.call('initialize',initializeParams);
  f.reply(initializedResult);assert.deepEqual(await pending,initializedResult);f.client.initialized();
}

async function noCall(f,method,params,pattern=/out of order/) {
  const before=f.sent.length;const pending=f.client.call(method,params);pending.catch(()=>{});
  assert.equal(f.sent.length,before,'refused call must write zero frames');
  await assert.rejects(pending,pattern);
}

test('diagnostic handshake requires one validated initialize then one initialized notification',async t=>{
  const f=fixture(t);
  assert.throws(()=>f.client.initialized(),/out of order/);assert.equal(f.sent.length,0);
  await noCall(f,'permissionProfile/list',pageParams);
  const pending=f.client.call('initialize',initializeParams);pending.catch(()=>{});
  await noCall(f,'initialize',initializeParams);
  assert.throws(()=>f.client.initialized(),/out of order/);
  f.reply(initializedResult);assert.deepEqual(await pending,initializedResult);
  await noCall(f,'permissionProfile/list',pageParams);
  f.client.initialized();assert.deepEqual(f.sent.at(-1),{method:'initialized'});
  assert.throws(()=>f.client.initialized(),/out of order/);
  await noCall(f,'initialize',initializeParams);
  const profiles=f.client.call('permissionProfile/list',pageParams);
  f.reply({data:[],nextCursor:null});assert.deepEqual(await profiles,{data:[],nextCursor:null});
});

test('diagnostic requests are single flight and keep the explicit method allowlist',async t=>{
  const f=fixture(t);await ready(f);
  for(const method of ['turn/start','thread/start','account/read','account/login/start','model/list','item/tool/call','attestation/generate','currentTime/read','future/method']) {
    await noCall(f,method,{marker:'synthetic-private-params'},/Coding methods are disabled/);
  }
  const pending=f.client.call('permissionProfile/list',pageParams);pending.catch(()=>{});
  await noCall(f,'permissionProfile/list',pageParams);
  f.reply({data:[]});assert.deepEqual(await pending,{data:[]});
});

test('initialize builder cannot opt into auth tools or broaden caller capabilities',async t=>{
  for(const params of [{}, {...initializeParams,capabilities:{experimentalApi:true,requiredHumanApproval:true}},
    {...initializeParams,capabilities:{experimentalApi:true,requestAttestation:true}},
    {...initializeParams,clientInfo:{name:'foreign',version:'0.1.0'}},
    {...initializeParams,extensions:['synthetic-tool']}]) {
    await noCall(fixture(t),'initialize',params,/Invalid diagnostic request/);
  }
});

test('initialize requires all four schema fields exact current version home and platform',async t=>{
  const invalid=[
    ...Object.keys(initializedResult).map(field=>Object.fromEntries(Object.entries(initializedResult).filter(([key])=>key!==field))),
    ...Object.keys(initializedResult).map(field=>({...initializedResult,[field]:null})),
    {...initializedResult,codexHome:'relative-home'}, {...initializedResult,codexHome:'C:/different-synthetic-home'},
    {...initializedResult,platformFamily:'unix'}, {...initializedResult,platformOs:'linux'},
    ...['0.166.0-alpha.5.1','0.169.0-alpha.11.10','0.169.0-alpha.11.1-extra','0.169.0-alpha.12.1'].map(value=>({...initializedResult,userAgent:`codex/${value}`})),
  ];
  for(const response of invalid) {
    const f=fixture(t);const pending=f.client.call('initialize',initializeParams);
    const refused=assert.rejects(pending,closedError);f.reply(response);await refused;assert.equal(f.closes,1);
  }
});

test('malformed success and error envelopes close without exposing remote message or data',async t=>{
  const frames=[null,[],true,{id:1},{id:1,result:initializedResult,error:{code:-1,message:'synthetic-private-remote'}},
    {id:1,error:null},{id:1,error:'synthetic-private-remote'},
    ...[{message:'synthetic-private-remote'},{code:'-1',message:'synthetic-private-remote'},
      {code:1.5,message:'synthetic-private-remote'},{code:-1,message:3}].map(error=>({id:1,error})),
    {id:'1',result:initializedResult},{id:2,result:initializedResult},{id:1.5,result:initializedResult},
  ];
  for(const frame of frames) {
    const f=fixture(t);const pending=f.client.call('initialize',initializeParams);
    const refused=assert.rejects(pending,closedError);f.frame(frame);await refused;assert.equal(f.closes,1);
  }
});

test('well formed remote error rejects safely and cannot complete the handshake',async t=>{
  const f=fixture(t);const pending=f.client.call('initialize',initializeParams);
  const refused=assert.rejects(pending,{message:'Codex protocol request failed'});
  f.frame({id:1,error:{code:-32000,message:'synthetic-private-remote',data:{marker:'synthetic-private-data'}}});
  await refused;assert.throws(()=>f.client.initialized(),/closed|out of order/);
});

test('duplicate response closes the next pending request instead of reusing prior authority',async t=>{
  const f=fixture(t);await ready(f);
  const pending=f.client.call('permissionProfile/list',pageParams);const refused=assert.rejects(pending,closedError);
  f.frame({id:1,result:initializedResult});await refused;assert.equal(f.closes,1);
});

const baseApproval={threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-item',startedAtMs:1};
const permissions={fileSystem:{read:['C:/synthetic/read'],write:['C:/synthetic/write'],globScanMaxDepth:2,entries:[
  {access:'read',path:{type:'path',path:'C:/synthetic/read'}},
  {access:'write',path:{type:'glob_pattern',pattern:'C:/synthetic/**'}},
  {access:'deny',path:{type:'special',value:{kind:'root'}}},
]},network:{enabled:true}};
const serverRequests=[
  ['item/commandExecution/requestApproval',{...baseApproval,kind:'command',command:'synthetic-command',cwd:pageParams.cwd,
    availableDecisions:['accept','acceptForSession'],additionalPermissions:permissions,
    proposedExecpolicyAmendment:['synthetic-command'],proposedNetworkPolicyAmendments:[{action:'allow',host:'example.invalid'}],
    networkApprovalContext:{host:'example.invalid',protocol:'https'},commandActions:[{type:'unknown',command:'synthetic-command'}]}],
  ['item/fileChange/requestApproval',{...baseApproval,grantRoot:'C:/synthetic/grant'}],
  ['item/permissions/requestApproval',{...baseApproval,cwd:pageParams.cwd,permissions}],
  ['item/tool/requestUserInput',{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-item',isBlocking:true,
    questions:[{header:'Review',id:'synthetic-question',question:'Synthetic question?',isSecret:true}]}],
  ['mcpServer/elicitation/request',{serverName:'synthetic-server',threadId:'synthetic-thread',turnId:null,mode:'form',
    message:'Synthetic input',requestedSchema:{type:'object',properties:{answer:{type:'string'}}}}],
  ['item/tool/call',{threadId:'synthetic-thread',turnId:'synthetic-turn',callId:'synthetic-call',tool:'synthetic-tool',arguments:{marker:'synthetic-private-data'}}],
  ['account/chatgptAuthTokens/refresh',{reason:'unauthorized',previousAccountId:'synthetic-account'}],
  ['attestation/generate',{}],
  ['currentTime/read',{threadId:'synthetic-thread'}],
  ['applyPatchApproval',{callId:'synthetic-call',conversationId:'synthetic-thread',fileChanges:{'synthetic.txt':{type:'add',content:'synthetic-private-data'}}}],
  ['execCommandApproval',{callId:'synthetic-call',conversationId:'synthetic-thread',command:['synthetic-command'],cwd:pageParams.cwd,parsedCmd:[]}],
];

test('all eleven schema-valid server request surfaces and future unknown requests are denied exactly',async t=>{
  const f=fixture(t);await ready(f);
  for(const [method,params] of [...serverRequests,['future/request',{marker:'synthetic-private-data'}]]) {
    const id=`request-${method}`;f.frame({id,method,params});
    const expected=method==='item/permissions/requestApproval'?{permissions:{},scope:'turn'}:
      ['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)?{decision:'decline'}:null;
    assert.deepEqual(f.sent.at(-1),expected?{id,result:expected}:{id,error:unsupported});
  }
  assert.deepEqual(f.sent.filter(frame=>frame.method).map(frame=>frame.method),['initialize','initialized']);
});

test('command kinds and all elicitation modes never grant mutate policy or answer user requests',async t=>{
  const f=fixture(t);await ready(f);
  for(const kind of ['command','writeStdin','humanCommand']) {
    f.frame({id:kind,method:'item/commandExecution/requestApproval',params:{...serverRequests[0][1],kind}});
    assert.deepEqual(f.sent.at(-1),{id:kind,result:{decision:'decline'}});
  }
  const elicitation={serverName:'synthetic-server',threadId:'synthetic-thread',turnId:null};
  for(const params of [
    {...elicitation,mode:'form',message:'Synthetic',requestedSchema:{type:'object',properties:{}}},
    {...elicitation,mode:'openai/form',message:'Synthetic',requestedSchema:{}},
    {...elicitation,mode:'openaiForm',message:'Synthetic',requestedSchema:{}},
    {...elicitation,mode:'url',message:'Synthetic',elicitationId:'synthetic',url:'https://example.invalid/consent'},
    {...elicitation,mode:'openai/userVerification',challenge:'synthetic-device-proof',description:'Synthetic',title:'Synthetic'},
  ]) {
    f.frame({id:params.mode,method:'mcpServer/elicitation/request',params});
    assert.deepEqual(f.sent.at(-1),{id:params.mode,error:unsupported});
  }
});

test('only bounded string and exactly representable numeric request IDs are echoed',async t=>{
  const f=fixture(t);await ready(f);
  for(const id of ['x'.repeat(256),Number.MAX_SAFE_INTEGER,0,-1]) {
    f.frame({id,method:'future/request',params:{}});assert.deepEqual(f.sent.at(-1),{id,error:unsupported});
  }
  for(const id of ['x'.repeat(257),Number.MAX_SAFE_INTEGER+1,1.5,null,{},[]]) {
    const invalid=fixture(t);const pending=invalid.client.call('initialize',initializeParams);
    const refused=assert.rejects(pending,closedError);invalid.frame({id,method:'future/request',params:{}});
    await refused;assert.equal(invalid.sent.length,1,'invalid request ID must not be rounded or echoed');
  }
});

for(const [label,character,fragmented] of [
  ['whole UTF-8 frame','é中🚀',false],['fragmented 2-byte UTF-8','é',true],
  ['fragmented 3-byte UTF-8','中',true],['fragmented 4-byte UTF-8','🚀',true],
])test(`stdio protocol preserves exact schema-valid values for ${label}`,async t=>{
  const home=`C:/synthetic/${character}`;const f=fixture(t,{identity:{...identity,home}});
  const pending=f.client.call('initialize',initializeParams);const expected={...initializedResult,codexHome:home};
  const frame=Buffer.from(JSON.stringify({id:1,result:expected})+'\n','utf8');
  if(fragmented) {
    const start=frame.indexOf(Buffer.from(character,'utf8'));const width=Buffer.byteLength(character,'utf8');
    const cuts=[1,start,...Array.from({length:width-1},(_,index)=>start+index+1),start+width,frame.length-1,frame.length];
    let offset=0;for(const end of cuts){f.output.write(frame.subarray(offset,end));offset=end;}
  }else f.output.write(frame);
  assert.deepEqual(await pending,expected);
});

test('partial frames wait for newline and truncated or malformed frames close safely',async t=>{
  const f=fixture(t);const pending=f.client.call('initialize',initializeParams);let settled=false;
  pending.then(()=>{settled=true;});const line=JSON.stringify({id:1,result:initializedResult});
  f.output.write(line);await Promise.resolve();assert.equal(settled,false);
  f.output.write('\n');assert.deepEqual(await pending,initializedResult);
  for(const malformed of ['not-json-synthetic-private','{"id":1,"result":']) {
    const invalid=fixture(t);const request=invalid.client.call('initialize',initializeParams);
    const refused=assert.rejects(request,closedError);invalid.output.end(malformed);await refused;assert.equal(invalid.closes,1);
  }
});

test('1 MiB framing admission counts UTF-8 bytes and permits a bounded notification control',async t=>{
  const f=fixture(t);const pending=f.client.call('initialize',initializeParams);
  const notice={method:'synthetic/notice',params:{padding:''}};
  notice.params.padding='x'.repeat(1024*1024-Buffer.byteLength(JSON.stringify(notice))-1);
  f.frame(notice);assert.equal(f.closes,0);f.reply(initializedResult);assert.deepEqual(await pending,initializedResult);
  const invalid=fixture(t);const request=invalid.client.call('initialize',initializeParams);
  const refused=assert.rejects(request,closedError);
  invalid.frame({method:'synthetic/notice',params:{padding:'é'.repeat(600000)}});await refused;assert.equal(invalid.closes,1);
});

test('notifications cannot complete handshake and stream close error and 5-second timeout settle pending',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const end of ['notification','output-end','output-close','output-error','input-close','input-error','timeout']) {
    const f=fixture(t);const pending=f.client.call('initialize',initializeParams);const refused=assert.rejects(pending,closedError);
    if(end==='notification') {f.frame({method:'initialized',params:{...initializedResult}});assert.throws(()=>f.client.initialized(),/out of order/);f.client.close();}
    else if(end==='output-end')f.output.end();
    else if(end==='output-close')f.output.emit('close');
    else if(end==='output-error')f.output.emit('error',new Error('synthetic-private-error'));
    else if(end==='input-close')f.input.emit('close');
    else if(end==='input-error')f.input.emit('error',new Error('synthetic-private-error'));
    else {t.mock.timers.tick(4999);assert.equal(f.closes,0);t.mock.timers.tick(1);}
    if(end==='output-close'||end==='input-close')assert.equal(f.closes,1,'stream closure must settle immediately');
    await refused;assert.equal(f.closes,1);await noCall(f,'initialize',initializeParams,/closed/);
  }
});

test('write failure and backpressure close once and stop unbounded denial traffic',async t=>{
  for(const write of [()=>{throw new Error('synthetic-private-write');},()=>false]) {
    const f=fixture(t,{write});const pending=f.client.call('initialize',initializeParams);pending.catch(()=>{});
    assert.equal(f.closes,1,'write failure or backpressure must close immediately');
    await assert.rejects(pending,closedError);
    for(let id=0;id<100;id++)f.frame({id,method:'future/request',params:{}});
    assert.equal(f.sent.length,1);f.client.close();assert.equal(f.closes,1);
  }
});

for(const terminal of ['input close','malformed output'])test(`initialized notification cannot restore readiness after synchronous ${terminal}`,async t=>{
  const output=new PassThrough();const sent=[];let closes=0;
  const input=new Writable({write(chunk,_encoding,done){
    const frame=JSON.parse(String(chunk));sent.push(frame);
    if(frame.method==='initialized') {
      if(terminal==='input close')input.emit('close');
      else output.write('synthetic-malformed-frame\n');
    }
    done();
  }});
  const client=runner.createProtocol({input,output,close(){closes++;}},identity);t.after(()=>client.close());
  const pending=client.call('initialize',initializeParams);
  output.write(JSON.stringify({id:sent[0].id,result:initializedResult})+'\n');
  assert.deepEqual(await pending,initializedResult,'valid initialize must reach the notification boundary');
  assert.throws(()=>client.initialized(),closedError);
  assert.throws(()=>client.assertReady(),closedError);
  await noCall({client,sent},'permissionProfile/list',pageParams,closedError);
  assert.equal(closes,1);assert.deepEqual(sent.map(frame=>frame.method),['initialize','initialized']);
});
