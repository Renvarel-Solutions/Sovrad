import {useRef,useState,type ReactElement} from 'react';
import type {AgentConnection} from '@renvarel/architect-core';
import {api,APIError} from '../api';

function Connection({connection,onChanged}:{connection:AgentConnection;onChanged:()=>Promise<void>}):ReactElement {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[sessionRequired,setSessionRequired]=useState(false);
  const acting=useRef(false),label=connection.target==='codex'?'Codex':'ChatGPT';
  async function act(kind:'connect'|'disconnect'):Promise<void> {
    if(acting.current)return;acting.current=true;setBusy(true);setError('');
    try{await api[kind](connection.id);await onChanged();}
    catch(value){
      setError(value instanceof Error?value.message:String(value));
      setSessionRequired(value instanceof APIError&&value.code==='LOCAL_SESSION_REQUIRED');
    }finally{acting.current=false;setBusy(false);}
  }
  async function renew():Promise<void> {
    setBusy(true);
    try{await api.localSession();setSessionRequired(false);setError('Session renewed. Review the connection and choose an action.');}
    catch(value){setError(value instanceof Error?value.message:String(value));}finally{setBusy(false);}
  }
  return <section className="connection-card" aria-label={`${label} connection`}><h3>{label}</h3>
    <p>{connection.state.replaceAll('_',' ')}</p><p>{connection.reason}</p>
    <p>Capabilities: {connection.capabilities.length?connection.capabilities.join(', '):'None available'}</p>
    {error&&<p className="error" role="alert">{error}</p>}
    {sessionRequired&&<button className="secondary-button" disabled={busy} onClick={()=>void renew()}>Renew local session</button>}
    <div className="item-actions"><button className="secondary-button" disabled={busy||sessionRequired} onClick={()=>void act('connect')}>Connect {label}</button>
      <button className="secondary-button" disabled={busy||sessionRequired} onClick={()=>void act('disconnect')}>Disconnect {label}</button></div>
    <p className="helper">Disconnect revokes local dependent work. Reconnecting does not restore revoked permission.</p>
  </section>;
}
export function ConnectionPanel({connections,onChanged}:{connections:AgentConnection[];onChanged:()=>Promise<void>}):ReactElement {
  return <section className="lead-strip"><h2>Agent connections</h2>
    <p>Availability and capabilities come from the local connection registry.</p>
    {connections.map(connection=><Connection key={connection.id} connection={connection} onChanged={onChanged}/>)}
    {!connections.length&&<p>No agent connection is available.</p>}
  </section>;
}
