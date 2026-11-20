import {useEffect,useRef,useState,type ReactElement} from 'react';
import type {ContextRef} from '@renvarel/architect-core';
import {BrowserHostAnnotationBridge,prepareHostHandoff} from './host-bridge';

export function HostHandoff({context,materialIdentity,enabled}:{
  context:ContextRef;materialIdentity:string;enabled:boolean;
}):ReactElement {
  const [shortComment,setShortComment]=useState('');
  const [approved,setApproved]=useState('');
  const [status,setStatus]=useState<{identity:string;message:string}|null>(null);
  const [bridge]=useState(()=>new BrowserHostAnnotationBridge());
  const preview=useRef<HTMLDivElement>(null);
  const dispose=useRef<(()=>void)|null>(null);
  const prepared=prepareHostHandoff(context,shortComment);
  const identity=JSON.stringify([materialIdentity,context,shortComment]);
  const availability=bridge.availability();
  const consent=approved===identity&&enabled&&prepared.valid;
  useEffect(()=>{
    setApproved('');setStatus(null);
    return ()=>{dispose.current?.();dispose.current=null;};
  },[identity,enabled]);

  function open():void {
    const current=prepareHostHandoff(context,shortComment),element=preview.current;
    if(!enabled||approved!==identity||!current.valid||!element)return;
    dispose.current?.();
    dispose.current=bridge.attachContext(element,context);
    const result=bridge.request(element,context,shortComment);
    setStatus({identity,message:result.message});setApproved('');
  }

  return <section aria-label="External host handoff" className="selected-material">
    <h3>External host handoff</h3>
    <p className="helper">The host will receive this selected reference and short comment. Review its editor before sending; the host may include page context and let you edit. Sovrad cannot choose the conversation or confirm delivery. No automatic screenshot is requested.</p>
    {!availability.available&&<p className="helper">{availability.reason}</p>}
    <label>Short host comment<textarea rows={3} maxLength={240} value={shortComment}
      onChange={event=>{setShortComment(event.target.value);setApproved('');setStatus(null);}}/></label>
    {!prepared.valid&&<p role={shortComment.trim()?'alert':undefined} className="helper">{prepared.reason}</p>}
    {prepared.valid&&<div key={identity} ref={preview} role="region" aria-label="Host reference preview"
      style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{prepared.preview}</div>}
    <label className="annotation-check"><input type="checkbox" checked={Boolean(consent)}
      disabled={!enabled||!prepared.valid||!availability.available}
      onChange={event=>setApproved(event.target.checked?identity:'')}/>
      I approve sharing this reference and short comment with the desktop host.</label>
    <button type="button" className="secondary-button" disabled={!consent||!availability.available} onClick={open}>Open host annotation</button>
    {status?.identity===identity&&<p role="status">{status.message}</p>}
  </section>;
}
