import {containsPrivateContent,type ContextRef} from '@renvarel/architect-core';

export type HostReference={
  projectId:string;itemId:string|null;workflowId:string|null;stepId:string|null;
  specRevision:number|null;mapRevision:number;
};
export type HostAvailability={available:boolean;reason:string};
export type PreparedHostHandoff={valid:true;metadata:HostReference;serialized:string;preview:string}|{valid:false;reason:string};
export type HostHandoffResult={accepted:boolean;message:string};
export interface HostAnnotationBridge {
  availability():HostAvailability;
  attachContext(element:HTMLElement,context:ContextRef):()=>void;
  request(element:HTMLElement,context:ContextRef,shortComment:string):HostHandoffResult;
}
type HostAPI={request:(element:HTMLElement,options:{metadata:HostReference;initialComment:string;omitScreenshot:true})=>unknown};
type HostDocument=Document&{oai?:{annotation?:Partial<HostAPI>}};
type Attachment={serialized:string;dispose:()=>void};
const unavailable='Desktop host annotations are unavailable in this browser.';
const notAccepted='Handoff request was not accepted; delivery is not confirmed.';

function reference(context:ContextRef):HostReference|null {
  if(!context||typeof context!=='object'||Array.isArray(context))return null;
  const metadata={projectId:context.projectId,itemId:context.itemId??null,workflowId:context.workflowId??null,
    stepId:context.stepId??null,specRevision:context.specRevision??null,mapRevision:context.mapRevision};
  if(typeof metadata.projectId!=='string'||!metadata.projectId||
    [metadata.projectId,metadata.itemId,metadata.workflowId,metadata.stepId].some(value=>
      value!==null&&(typeof value!=='string'||!value||value.length>256))||
    !Number.isSafeInteger(metadata.mapRevision)||metadata.mapRevision<1||
    (metadata.specRevision!==null&&(!Number.isSafeInteger(metadata.specRevision)||metadata.specRevision<1))||
    (metadata.workflowId===null)!==(metadata.specRevision===null)||
    (metadata.stepId!==null&&metadata.workflowId===null))return null;
  return metadata;
}

export function prepareHostHandoff(context:ContextRef,shortComment:string):PreparedHostHandoff {
  const metadata=reference(context);
  if(!metadata)return {valid:false,reason:'The selected reference has invalid revisions, incomplete workflow context, or values beyond the 256-unit limit.'};
  const serialized=JSON.stringify(metadata);
  if(new TextEncoder().encode(serialized).byteLength>2048)return {valid:false,reason:'The selected reference exceeds the 2,048-byte host limit.'};
  if(typeof shortComment!=='string'||shortComment.length>240)return {valid:false,reason:'The short host comment must be at most 240 UTF-16 units. Nothing was shortened.'};
  if(containsPrivateContent({metadata,shortComment}))return {valid:false,reason:'Credential-like or private content cannot be shared with the host. Review the reference and short comment.'};
  if(!shortComment.trim())return {valid:false,reason:'Write a separate short comment before approving this handoff.'};
  const labels:Record<keyof HostReference,string>={projectId:'Project reference',itemId:'Item reference',workflowId:'Workflow reference',
    stepId:'Stage reference',specRevision:'Specification revision',mapRevision:'Map revision'};
  const preview='Selected reference\n'+Object.entries(metadata).map(([key,value])=>`${labels[key as keyof HostReference]}: ${String(value)}`).join('\n')+
    '\nShort comment:\n'+shortComment;
  if(containsPrivateContent(preview))return {valid:false,reason:'Credential-like or private content cannot be shared with the host. Review the reference and short comment.'};
  return {valid:true,metadata,serialized,preview};
}

function visibleTarget(element:HTMLElement,hostDocument:Document):boolean {
  const view=hostDocument.defaultView;
  if(!view||!(element instanceof view.HTMLElement)||element.ownerDocument!==hostDocument||!element.isConnected||element.getRootNode()!==hostDocument)return false;
  const rect=element.getBoundingClientRect();
  if(!element.getClientRects().length||rect.width<=0||rect.height<=0||rect.bottom<=0||rect.right<=0||
    rect.top>=view.innerHeight||rect.left>=view.innerWidth)return false;
  for(let node:HTMLElement|null=element;node;node=node.parentElement){
    const style=view.getComputedStyle(node);
    if(node.hidden||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
    if(node!==element&&/(auto|scroll|hidden|clip)/.test(style.overflow+style.overflowX+style.overflowY)){
      const clip=node.getBoundingClientRect();
      if(rect.bottom<=clip.top||rect.top>=clip.bottom||rect.right<=clip.left||rect.left>=clip.right)return false;
    }
  }
  return true;
}

export class BrowserHostAnnotationBridge implements HostAnnotationBridge {
  private readonly attached=new WeakMap<HTMLElement,Attachment>();
  constructor(private readonly hostDocument:Document=document) {}

  private api():HostAPI|null {
    try{
      const annotation=(this.hostDocument as HostDocument).oai?.annotation;
      return typeof annotation?.request==='function'?annotation as HostAPI:null;
    }catch{return null;}
  }

  availability():HostAvailability {
    return this.api()?{available:true,reason:''}:{available:false,reason:unavailable};
  }

  attachContext(element:HTMLElement,context:ContextRef):()=>void {
    const metadata=reference(context);
    if(!metadata||containsPrivateContent(metadata))return ()=>{};
    const serialized=JSON.stringify(metadata);
    if(new TextEncoder().encode(serialized).byteLength>2048)return ()=>{};
    this.attached.get(element)?.dispose();
    const owned={'oai-annotatable':'Selected reference','oai-annotation-metadata':serialized};
    const previous=Object.keys(owned).map(name=>[name,element.getAttribute(name)] as const);
    for(const [name,value] of Object.entries(owned))element.setAttribute(name,value);
    let disposed=false;
    const dispose=():void=>{
      if(disposed)return;
      disposed=true;
      if(this.attached.get(element)!==attachment)return;
      this.attached.delete(element);
      for(const [name,value] of previous){
        if(element.getAttribute(name)!==owned[name as keyof typeof owned])continue;
        if(value===null)element.removeAttribute(name);else element.setAttribute(name,value);
      }
    };
    const attachment={serialized,dispose};
    this.attached.set(element,attachment);
    return dispose;
  }

  request(element:HTMLElement,context:ContextRef,shortComment:string):HostHandoffResult {
    const prepared=prepareHostHandoff(context,shortComment),api=this.api();
    if(!api)return {accepted:false,message:unavailable};
    if(!prepared.valid)return {accepted:false,message:prepared.reason};
    const allowedAttributes=['role','aria-label','class','style','id','oai-annotatable','oai-annotation-metadata'];
    if(!visibleTarget(element,this.hostDocument)||this.attached.get(element)?.serialized!==prepared.serialized||
      element.getAttribute('oai-annotation-metadata')!==prepared.serialized||element.getAttribute('oai-annotatable')!=='Selected reference'||
      element.textContent!==prepared.preview||element.children.length||
      Array.from(element.attributes).some(attribute=>!allowedAttributes.includes(attribute.name))||
      containsPrivateContent(Array.from(element.attributes,attribute=>attribute.value))){
      return {accepted:false,message:'The selected reference preview changed or is unavailable. Review it before another handoff.'};
    }
    try{
      const result=api.request(element,{metadata:{...prepared.metadata},initialComment:shortComment,omitScreenshot:true});
      const accepted=Boolean(result&&typeof result==='object'&&'accepted' in result&&result.accepted===true);
      return {accepted,message:accepted?'Handoff request accepted; delivery is not confirmed.':notAccepted};
    }catch{return {accepted:false,message:notAccepted};}
  }
}
