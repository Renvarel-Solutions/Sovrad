import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Storage} from './storage.js';
import {projectFailure} from './project-routes.js';
const empty=z.object({}).strict();
export function registerConnections(app:FastifyInstance,storage:Storage):void {
  app.get('/api/local-session',async(req,reply)=>{
    try{empty.parse(req.query);if(req.method==='HEAD')return reply.code(200).send();
      const boot=storage.sessions.bootstrap(req.headers.cookie);if(boot.setCookie)reply.header('Set-Cookie',boot.setCookie);return {session:boot.session};
    }catch(e){return projectFailure(reply,e);}
  });
  app.get('/api/connections',async(req,reply)=>{try{empty.parse(req.query);return {connections:storage.connections.list()};}catch(e){return projectFailure(reply,e);}});
  for(const action of ['connect','disconnect'] as const)app.post(`/api/connections/:id/${action}`,async(req,reply)=>{
    try{empty.parse(req.query);empty.parse(req.body);const {id}=z.object({id:z.string().min(1).max(100)}).strict().parse(req.params);
      storage.sessions.require(req.headers.cookie);
      const connection=storage.connections[action](id);
      return action==='connect'?reply.code(503).send({connection,error:'The requested agent connection is unavailable.',code:'CONNECTION_UNAVAILABLE'}):{connection};
    }catch(e){return projectFailure(reply,e);}
  });
}
