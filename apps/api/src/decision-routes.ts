import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Storage} from './storage.js';
import {projectFailure} from './project-routes.js';
import {decisionActionSchema} from './decision-store.js';

const empty=z.object({}).strict();
export function registerDecisions(app:FastifyInstance,storage:Storage):void {
  app.get('/api/decisions',async(req,reply)=>{try{return storage.decisions.list({...req.query as object});}catch(e){return projectFailure(reply,e);}});
  app.post('/api/decisions/:id/action',async(req,reply)=>{
    try{empty.parse(req.query);const {id}=z.object({id:z.string().uuid()}).strict().parse(req.params);
      const session=storage.sessions.require(req.headers.cookie);const input=decisionActionSchema.parse(req.body);
      return {decision:storage.decisions.resolve(id,input,session)};
    }catch(e){return projectFailure(reply,e);}
  });
  app.get('/api/evidence',async(req,reply)=>{try{return storage.evidence.list({...req.query as object});}catch(e){return projectFailure(reply,e);}});
  app.get('/api/activity',async(req,reply)=>{try{return storage.evidence.activity({...req.query as object});}catch(e){return projectFailure(reply,e);}});
}
