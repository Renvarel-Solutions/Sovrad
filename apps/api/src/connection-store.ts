import type {AgentConnection} from '@renvarel/architect-core';
import {ExperienceContext} from './experience-context.js';
import type {ExecutionBindingStore} from './execution-binding-store.js';
import {ProjectError} from './project-store.js';

export class ConnectionStore {
  constructor(private readonly c:ExperienceContext,private readonly bindings:ExecutionBindingStore){
    for(const target of ['codex','chatgpt'] as const){
      const connection:AgentConnection={id:target,target,capabilities:[],state:'unavailable',lastSeenAt:null,
        reason:'A supported adapter and its capability proof are not available. No agent is connected.'};
      this.c.db.prepare('INSERT OR IGNORE INTO connections(id,payload) VALUES (?,?)').run(target,JSON.stringify(connection));
    }
  }
  list():AgentConnection[]{return (this.c.db.prepare('SELECT payload FROM connections ORDER BY id').all() as {payload:string}[]).map(r=>JSON.parse(r.payload) as AgentConnection);}
  get(id:string):AgentConnection {const c=this.list().find(c=>c.id===id);if(!c)throw new ProjectError(404,'Connection not found');return c;}
  connect(id:string):AgentConnection{return this.get(id);}
  disconnect(id:string):AgentConnection {
    return this.c.db.transaction(()=>{
      const connection=this.get(id);
      const rows=this.c.db.prepare("SELECT o.work_id,o.actual_target,o.state,a.payload FROM work_outbox o JOIN annotations a ON a.id=o.annotation_id WHERE o.state IN ('pending','claimed')").all() as {work_id:string;actual_target:string|null;state:string;payload:string}[];
      for(const row of rows){const a=JSON.parse(row.payload) as {target:string};
        const dependent=row.actual_target===id||row.state==='pending'&&(a.target===id||a.target==='automatic');
        if(!dependent)continue;
        const w=this.c.rawWork(row.work_id);this.c.revokeOutbox(w.id);
        if(!['cancelled','superseded','done'].includes(w.state))this.c.change(w,'blocked','connection_disconnected','The selected agent connection was disconnected. Fresh review is required.');
      }
      this.bindings.reconcileCurrent();return connection;
    }).immediate();
  }
}
