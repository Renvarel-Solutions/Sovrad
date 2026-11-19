import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import * as runner from './index.ts';

const version='0.169.0-alpha.11.1';
const identity={home:'C:/synthetic-diagnostic-home',cwd:'C:/synthetic-diagnostic-workspace',platformFamily:'windows',platformOs:'windows'};
const initializedResult={userAgent:`codex/${version}`,codexHome:identity.home,platformFamily:'windows',platformOs:'windows'};
const closedError=error=>error instanceof Error&&error.message==='Codex protocol closed';

function diagnostic() {
  assert.equal(typeof runner.diagnoseConnection,'function','runner must export its transport-only diagnostic helper');
  return runner.diagnoseConnection;
}

function transport(t,onFrame) {
  const output=new PassThrough();const sent=[];let closes=0;
  const input=new Writable({write(chunk,_encoding,done){
    const frame=JSON.parse(String(chunk));sent.push(frame);done();
    queueMicrotask(()=>onFrame?.(frame,{reply(result){output.write(JSON.stringify({id:frame.id,result})+'\n');},output}));
  }});
  t.after(()=>{input.destroy();output.destroy();});
  return {input,output,close(){closes++;},sent,get closes(){return closes;}};
}

function pageServer(page) {
  return (frame,server)=>{
    if(frame.method==='initialize')server.reply(initializedResult);
    else if(frame.method==='permissionProfile/list')server.reply(page);
  };
}

test('current diagnostic version is pinned without changing native isolation readiness',()=>{
  assert.equal(runner.CODEX_VERSION,version);
  assert.equal(runner.isolationPreflight().ready,false);
});

test('transport diagnostic uses fixed handshake finite pages and returns no execution authority',async t=>{
  const diagnose=diagnostic();const wire=transport(t,pageServer({data:[]}));
  const result=await diagnose(wire,identity);
  assert.deepEqual(wire.sent,[
    {id:1,method:'initialize',params:{clientInfo:{name:'sovrad_preview',title:'Sovrad protocol probe',version:'0.1.0'},capabilities:{experimentalApi:true}}},
    {method:'initialized'},
    {id:2,method:'permissionProfile/list',params:{cwd:identity.cwd,limit:50}},
  ]);
  assert.deepEqual(result,{version,handshake:true,codingEnabled:false,ready:false,profiles:[]});
  assert.equal(wire.closes,1);
  assert.equal(JSON.stringify(result).includes(identity.home),false);
  assert.equal(JSON.stringify(result).includes(identity.cwd),false);
});

test('profile projection preserves allowed false and null absent or Unicode descriptions',async t=>{
  const diagnose=diagnostic();
  const profiles=[{id:'synthetic-denied',allowed:false},{id:'synthetic-null',allowed:true,description:null},
    {id:'synthetic-unicode',allowed:true,description:'مراجعة آمنة — café 日本語 🙂'}];
  for(const ending of [{}, {nextCursor:null}]) {
    const wire=transport(t,pageServer({data:profiles,...ending}));
    assert.deepEqual((await diagnose(wire,identity)).profiles,profiles);assert.equal(wire.closes,1);
  }
});

test('complete multipage discovery retains exact cursor and finite limit without selecting a profile',async t=>{
  const diagnose=diagnostic();let pages=0;const first={id:'synthetic-one',allowed:false};const second={id:'synthetic-two',allowed:true};
  const wire=transport(t,(frame,server)=>{
    if(frame.method==='initialize')server.reply(initializedResult);
    if(frame.method==='permissionProfile/list')server.reply(++pages===1?{data:[first],nextCursor:'synthetic-next'}:{data:[second],nextCursor:null});
  });
  const result=await diagnose(wire,identity);assert.deepEqual(result.profiles,[first,second]);
  assert.deepEqual(wire.sent.filter(frame=>frame.method==='permissionProfile/list').map(frame=>frame.params),[
    {cwd:identity.cwd,limit:50},{cwd:identity.cwd,limit:50,cursor:'synthetic-next'},
  ]);
  assert.equal(result.ready,false);assert.equal(result.codingEnabled,false);assert.equal(wire.closes,1);
});

test('diagnostic validates identity before transport and rejects current-version or schema mismatches',async t=>{
  const diagnose=diagnostic();
  for(const invalid of [{...identity,home:'relative'}, {...identity,cwd:'relative'}, {...identity,platformFamily:''}, {...identity,platformOs:''}]) {
    const wire=transport(t,pageServer({data:[]}));await assert.rejects(()=>diagnose(wire,invalid),closedError);
    assert.equal(wire.sent.length,0);assert.equal(wire.closes,1);
  }
  for(const result of [
    {...initializedResult,userAgent:`codex/${version}0`},{...initializedResult,userAgent:'codex/0.166.0-alpha.5.1'},
    {...initializedResult,codexHome:'C:/different-synthetic-home'},{...initializedResult,platformFamily:'unix'},
    {...initializedResult,platformOs:'linux'}, {userAgent:`codex/${version}`,codexHome:identity.home},
  ]) {
    const wire=transport(t,(frame,server)=>{if(frame.method==='initialize')server.reply(result);});
    await assert.rejects(()=>diagnose(wire,identity),closedError);
    assert.equal(wire.sent.length,1);assert.equal(wire.closes,1);
  }
});

test('invalid profile pages fail closed without returning partial discovery',async t=>{
  const diagnose=diagnostic();
  const pages=[null,[],{}, {data:null},{data:{}},{data:[null]},{data:[{id:'synthetic'}]},
    {data:[{id:3,allowed:true}]},{data:[{id:'synthetic',allowed:'true'}]},
    {data:[{id:'synthetic',allowed:true,description:3}]},{data:[],nextCursor:3},
    {data:[{id:'x'.repeat(257),allowed:true}]},{data:[{id:'synthetic',allowed:true,description:'x'.repeat(2049)}]},
    {data:[],nextCursor:'x'.repeat(2049)},
    {data:Array.from({length:51},(_,id)=>({id:`synthetic-${id}`,allowed:false}))},
  ];
  for(const page of pages) {
    const wire=transport(t,pageServer(page));await assert.rejects(()=>diagnose(wire,identity),closedError);
    assert.equal(wire.closes,1);assert.equal(wire.sent.filter(frame=>frame.method==='permissionProfile/list').length,1);
  }
});

test('maximum admitted identifier description and cursor lengths have successful controls',async t=>{
  const diagnose=diagnostic();let pages=0;
  const profile={id:'i'.repeat(256),allowed:false,description:'🙂'.repeat(1024)};
  const wire=transport(t,(frame,server)=>{
    if(frame.method==='initialize')server.reply(initializedResult);
    if(frame.method==='permissionProfile/list')server.reply(++pages===1?{data:[profile],nextCursor:'c'.repeat(2048)}:{data:[]});
  });
  assert.deepEqual((await diagnose(wire,identity)).profiles,[profile]);
  assert.equal(wire.sent.at(-1).params.cursor.length,2048);assert.equal(wire.closes,1);
});

test('ten pages and 500 records complete but an eleventh continuation is refused',async t=>{
  const diagnose=diagnostic();
  for(const incomplete of [false,true]) {
    let pages=0;const wire=transport(t,(frame,server)=>{
      if(frame.method==='initialize')server.reply(initializedResult);
      if(frame.method==='permissionProfile/list') {
        const page=++pages;server.reply({data:Array.from({length:50},(_,index)=>({id:`synthetic-${page}-${index}`,allowed:false})),
          nextCursor:page===10&&!incomplete?null:`cursor-${page}`});
      }
    });
    if(incomplete)await assert.rejects(()=>diagnose(wire,identity),closedError);
    else assert.equal((await diagnose(wire,identity)).profiles.length,500);
    assert.equal(pages,10);assert.equal(wire.closes,1);
  }
});

test('repeated cyclic cursors and inconsistent duplicate profile IDs refuse incomplete discovery',async t=>{
  const diagnose=diagnostic();
  for(const mode of ['repeated','cycle','inconsistent-id']) {
    let pages=0;const wire=transport(t,(frame,server)=>{
      if(frame.method==='initialize')server.reply(initializedResult);
      if(frame.method==='permissionProfile/list') {
        const page=++pages;
        server.reply(mode==='inconsistent-id'?{data:[{id:'synthetic-duplicate',allowed:page===1}],nextCursor:page===1?'next':null}:
          {data:[],nextCursor:mode==='repeated'?'same':page%2?'one':'two'});
      }
    });
    await assert.rejects(()=>diagnose(wire,identity),closedError);assert.equal(wire.closes,1);
    assert.equal(pages,mode==='cycle'?3:2);
  }
});

test('profile request timeout rejects and closes after 5 seconds with no partial result',async t=>{
  const diagnose=diagnostic();t.mock.timers.enable({apis:['setTimeout']});
  const wire=transport(t,(frame,server)=>{if(frame.method==='initialize')server.reply(initializedResult);});
  const pending=diagnose(wire,identity);const refused=assert.rejects(pending,closedError);
  for(let flush=0;flush<8;flush++)await Promise.resolve();
  assert.equal(wire.sent.at(-1).method,'permissionProfile/list');
  t.mock.timers.tick(4999);assert.equal(wire.closes,0);t.mock.timers.tick(1);
  await refused;assert.equal(wire.closes,1);assert.equal(wire.sent.length,3);
});

test('aggregate discovery deadline is 30 seconds even when each page arrives within 5 seconds',async t=>{
  const diagnose=diagnostic();t.mock.timers.enable({apis:['setTimeout']});let pages=0;
  const wire=transport(t,(frame,server)=>{
    if(frame.method==='initialize')server.reply(initializedResult);
    if(frame.method==='permissionProfile/list')setTimeout(()=>server.reply({data:[{id:`synthetic-${++pages}`,allowed:false}],nextCursor:`cursor-${pages}`}),4000);
  });
  const pending=diagnose(wire,identity);const refused=assert.rejects(pending,closedError);
  for(let flush=0;flush<8;flush++)await Promise.resolve();
  for(let page=0;page<7;page++) {t.mock.timers.tick(4000);for(let flush=0;flush<8;flush++)await Promise.resolve();}
  assert.equal(wire.closes,0);t.mock.timers.tick(1999);assert.equal(wire.closes,0);t.mock.timers.tick(1);
  await refused;assert.equal(wire.closes,1);assert.equal(pages,7);
  assert.equal(wire.sent.filter(frame=>frame.method==='permissionProfile/list').length,8);
});

for(const [label,trailing] of [
  ['malformed JSON',()=>'synthetic-malformed-frame\n'],
  ['duplicate response',id=>JSON.stringify({id,result:{data:[]}})+'\n'],
  ['invalid envelope',id=>JSON.stringify({id,result:{data:[]},error:{code:-1,message:'synthetic-private-remote'}})+'\n'],
])test(`final profile page followed by ${label} refuses a completed diagnostic`,async t=>{
  const diagnose=diagnostic();
  const wire=transport(t,(frame,server)=>{
    if(frame.method==='initialize')server.reply(initializedResult);
    if(frame.method==='permissionProfile/list') {
      const final={id:frame.id,result:{data:[{id:'synthetic-final',allowed:false}],nextCursor:null}};
      // A single transport chunk resolves the page and then invalidates the same session.
      server.output.write(JSON.stringify(final)+'\n'+trailing(frame.id));
    }
  });
  await assert.rejects(()=>diagnose(wire,identity),closedError);
  assert.equal(wire.closes,1);
});
