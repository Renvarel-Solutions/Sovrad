import {test,expect} from './fixtures';

test('host projection enforces scalar, UTF-16 and UTF-8 boundaries without dropping or shortening values',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const modulePath='/src/annotations/host-bridge.ts';
    const {prepareHostHandoff}=await import(modulePath);
    const context={projectId:'fictional-project',mapRevision:1};
    const valid=prepareHostHandoff(context,'Clean fictional question.');
    const stringBoundary=prepareHostHandoff({...context,projectId:'x'.repeat(256)},'Question.');
    const unicode='🧭'.repeat(120);
    return {valid,stringBoundary,unicode:prepareHostHandoff(context,unicode),invalid:[
      prepareHostHandoff({...context,projectId:'x'.repeat(257)},'Question.'),
      prepareHostHandoff({...context,projectId:'界'.repeat(256),itemId:'界'.repeat(256),
        workflowId:'界'.repeat(256),stepId:'界'.repeat(256),specRevision:1},'Question.'),
      prepareHostHandoff({...context,mapRevision:Infinity},'Question.'),
      prepareHostHandoff({...context,specRevision:NaN},'Question.'),
      prepareHostHandoff({...context,projectId:{nested:true}},'Question.'),
      prepareHostHandoff({...context,itemId:['nested']},'Question.'),
      prepareHostHandoff(context,unicode+'x'),
      prepareHostHandoff({...context,projectId:'password=FictionalCredentialMarker123'},'Question.'),
    ]};
  });
  expect(result.valid).toMatchObject({valid:true,metadata:{projectId:'fictional-project',itemId:null,
    workflowId:null,stepId:null,specRevision:null,mapRevision:1}});
  expect(Object.keys(result.valid.metadata)).toHaveLength(6);
  expect(JSON.parse(result.valid.serialized)).toEqual(result.valid.metadata);
  expect(result.stringBoundary.valid).toBe(true);
  expect(result.stringBoundary.metadata.projectId).toHaveLength(256);
  expect(result.unicode.valid).toBe(true);
  expect(result.unicode.preview).toContain('🧭'.repeat(120));
  for(const invalid of result.invalid){expect(invalid.valid).toBe(false);expect(invalid.reason.length).toBeGreaterThan(0);}
  expect(result.invalid[1].reason).toContain('2,048');
});

test('host attachment restores foreign attributes, disposes twice safely and refuses a wrong target or context',async({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(document,'oai',{configurable:true,value:{annotation:{request:()=>({accepted:true})}}});
  });
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const modulePath='/src/annotations/host-bridge.ts';
    const {BrowserHostAnnotationBridge,prepareHostHandoff}=await import(modulePath);
    const bridge=new BrowserHostAnnotationBridge();
    const context={projectId:'fictional-project',mapRevision:1},comment='Clean reference question.';
    const prepared=prepareHostHandoff(context,comment);
    const element=document.createElement('div');
    element.style.cssText='position:fixed;left:0;top:0;width:400px;height:200px;white-space:pre-wrap';
    element.textContent=prepared.preview;
    document.body.append(element);
    element.setAttribute('oai-annotatable','Foreign label');
    element.setAttribute('oai-annotation-metadata','{"foreign":"retained"}');
    element.setAttribute('data-foreign','Retained ordinary attribute.');
    const dispose=bridge.attachContext(element,context);
    dispose();dispose();
    const restored={label:element.getAttribute('oai-annotatable'),metadata:element.getAttribute('oai-annotation-metadata'),
      foreign:element.getAttribute('data-foreign')};
    element.removeAttribute('data-foreign');
    const first=bridge.attachContext(element,context),second=bridge.attachContext(element,context);
    first();
    const other=element.cloneNode(true) as HTMLElement;
    document.body.append(other);
    const wrongTarget=bridge.request(other,context,comment);
    const wrongContext=bridge.request(element,{...context,mapRevision:2},comment);
    const positive=bridge.request(element,context,comment);
    element.setAttribute('oai-annotation-metadata','{"unreviewed":"different"}');
    const changed=bridge.request(element,context,comment);
    second();second();
    const keptNewForeign=element.getAttribute('oai-annotation-metadata');
    const afterCleanup=bridge.request(element,context,comment);
    const finalLabel=element.getAttribute('oai-annotatable');
    element.remove();other.remove();
    return {restored,wrongTarget,wrongContext,positive,changed,keptNewForeign,afterCleanup,finalLabel};
  });
  expect(result.restored).toEqual({label:'Foreign label',metadata:'{"foreign":"retained"}',foreign:'Retained ordinary attribute.'});
  expect(result.positive.accepted).toBe(true);
  for(const refused of [result.wrongTarget,result.wrongContext,result.changed,result.afterCleanup])expect(refused.accepted).toBe(false);
  expect(result.keptNewForeign).toBe('{"unreviewed":"different"}');
  expect(result.finalLabel).toBe('Foreign label');
});

test('host references require positive safe revisions and complete workflow and stage relationships',async({page})=>{
  await page.addInitScript(()=>{
    const state={calls:0};
    Object.defineProperty(window,'__referenceHost',{value:state});
    Object.defineProperty(document,'oai',{configurable:true,value:{annotation:{request:()=>{state.calls++;return {accepted:true};}}}});
  });
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const modulePath='/src/annotations/host-bridge.ts';
    const {BrowserHostAnnotationBridge,prepareHostHandoff}=await import(modulePath);
    const bridge=new BrowserHostAnnotationBridge();
    const host=(window as Window&{__referenceHost:{calls:number}}).__referenceHost;
    const comment='Clean fictional reference question.';
    const project={projectId:'fictional-project',mapRevision:1};
    const workflow={...project,workflowId:'fictional-workflow',specRevision:1};
    const stage={...workflow,stepId:'fictional-stage'};
    const makeTarget=(text:string):HTMLDivElement=>{
      const element=document.createElement('div');
      element.style.cssText='position:fixed;left:0;top:0;width:400px;height:200px;white-space:pre-wrap';
      element.textContent=text;document.body.append(element);return element;
    };
    const invalidRevisions=[0,-1,1.5,Number.MAX_SAFE_INTEGER+1];
    const invalidInputs:[string,unknown][]=[
      ...invalidRevisions.map(value=>[`map revision ${value}`,{...project,mapRevision:value}] as [string,unknown]),
      ...invalidRevisions.map(value=>[`specification revision ${value}`,{...workflow,specRevision:value}] as [string,unknown]),
      ['workflow without specification revision',{...project,workflowId:'fictional-workflow'}],
      ['stage without workflow',{...project,stepId:'fictional-stage'}],
      ['specification revision without workflow',{...project,specRevision:1}],
      ['stage and specification revision without workflow',{...project,stepId:'fictional-stage',specRevision:1}],
      ['null context',null],['undefined context',undefined],['string context','fictional-context'],
      ['number context',1],['array context',[]],
    ];
    const controls=[project,workflow,stage,{...stage,mapRevision:Number.MAX_SAFE_INTEGER,specRevision:Number.MAX_SAFE_INTEGER}]
      .map(context=>{
        const prepared=prepareHostHandoff(context,comment),element=makeTarget(prepared.preview);
        const dispose=bridge.attachContext(element,context),handoff=bridge.request(element,context,comment);
        dispose();element.remove();return {prepared,handoff};
      });
    const controlCalls=host.calls;
    const invalid=invalidInputs.map(([label,context])=>{
      let prepared=null,prepareThrew=false,attachThrew=false,requestThrew=false,handoff=null;
      try{prepared=prepareHostHandoff(context,comment);}catch{prepareThrew=true;}
      const element=makeTarget(prepared?.valid?prepared.preview:controls[0].prepared.preview);
      const foreign={label:'Retained foreign label',metadata:'{"foreign":"retained"}'};
      element.setAttribute('oai-annotatable',foreign.label);element.setAttribute('oai-annotation-metadata',foreign.metadata);
      let dispose:()=>void=()=>{};
      try{dispose=bridge.attachContext(element,context);}catch{attachThrew=true;}
      const attached={label:element.getAttribute('oai-annotatable'),metadata:element.getAttribute('oai-annotation-metadata')};
      const before=host.calls;
      try{handoff=bridge.request(element,context,comment);}catch{requestThrew=true;}
      const callDelta=host.calls-before;
      dispose();dispose();
      const cleaned={label:element.getAttribute('oai-annotatable'),metadata:element.getAttribute('oai-annotation-metadata')};
      element.remove();return {label,prepared,prepareThrew,attachThrew,requestThrew,handoff,foreign,attached,cleaned,callDelta};
    });
    return {controls,controlCalls,invalid};
  });
  expect(result.controls).toHaveLength(4);
  expect(result.controlCalls).toBe(4);
  for(const valid of result.controls){expect(valid.prepared.valid).toBe(true);expect(valid.handoff.accepted).toBe(true);}
  expect(result.controls[0].prepared.metadata.projectId).toBe('fictional-project');
  expect(result.controls[1].prepared.metadata.workflowId).toBe('fictional-workflow');
  expect(result.controls[2].prepared.metadata.stepId).toBe('fictional-stage');
  for(const invalid of result.invalid){
    expect([invalid.prepareThrew,invalid.attachThrew,invalid.requestThrew],invalid.label).toEqual([false,false,false]);
    expect(invalid.prepared?.valid,invalid.label).toBe(false);
    expect(invalid.prepared?.reason.length,invalid.label).toBeGreaterThan(0);
    expect(invalid.attached,invalid.label).toEqual(invalid.foreign);
    expect(invalid.cleaned,invalid.label).toEqual(invalid.foreign);
    expect(invalid.handoff?.accepted,invalid.label).toBe(false);
    expect(invalid.callDelta,invalid.label).toBe(0);
  }
});
