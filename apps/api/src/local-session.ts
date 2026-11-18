import {randomBytes,randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {LocalActionSession} from '@renvarel/architect-core';
import {hash} from './experience-context.js';
import {ProjectError} from './project-store.js';

export class LocalSessionError extends ProjectError {
  readonly code='LOCAL_SESSION_REQUIRED';
  constructor(){super(403,'A current local action session is required.');}
}
export class LocalSessionStore {
  constructor(private readonly db:Database.Database,private readonly now:()=>number=()=>Date.now()){}
  private token(header:string|undefined):string|null {
    const values=(header??'').split(';').map(x=>x.trim()).filter(x=>x.split('=')[0]==='sovrad_local_action');
    if(values.length!==1)return null;
    const value=values[0].slice('sovrad_local_action='.length);
    return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
  }
  require(header:string|undefined):LocalActionSession {
    const token=this.token(header);if(!token)throw new LocalSessionError();
    const row=this.db.prepare('SELECT id,expires_at FROM local_sessions WHERE token_hash=?').get(hash(token)) as {id:string;expires_at:string}|undefined;
    if(!row||Date.parse(row.expires_at)<=this.now())throw new LocalSessionError();
    return {id:row.id,expiresAt:row.expires_at,source:'local-owner-session'};
  }
  bootstrap(header:string|undefined):{session:LocalActionSession;setCookie:string|null} {
    try{return {session:this.require(header),setCookie:null};}catch{/* Only a GET bootstrap creates a replacement. */}
    const token=randomBytes(32).toString('base64url'),session:LocalActionSession={id:randomUUID(),expiresAt:new Date(this.now()+1_800_000).toISOString(),source:'local-owner-session'};
    this.db.prepare('INSERT INTO local_sessions(id,token_hash,expires_at) VALUES (?,?,?)').run(session.id,hash(token),session.expiresAt);
    return {session,setCookie:`sovrad_local_action=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=1800`};
  }
}
