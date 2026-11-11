import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Storage} from './storage.js';
import {projectFailure} from './project-routes.js';
import {WorkController} from './work-controller.js';

const params = z.object({id:z.string().uuid()}).strict();
const empty = z.object({}).strict();
const query = (value:unknown):Record<string,unknown> => ({...(value as Record<string,unknown>)});

export function registerWork(app:FastifyInstance, storage:Storage):void {
  const store = storage.work, controller = new WorkController(store);
  app.get('/api/annotations',async(req,reply) => {
    try { return store.annotations(query(req.query)); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/annotations',async(req,reply) => {
    try { empty.parse(req.query); return reply.code(201).send(await controller.submitAnnotation(req.body as never)); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.get('/api/work',async(req,reply) => {
    try { return store.list(query(req.query)); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.get('/api/work/:id',async(req,reply) => {
    try { empty.parse(req.query); return store.detail(params.parse(req.params).id); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/work/:id/amend',async(req,reply) => {
    try { empty.parse(req.query); return reply.code(201).send(await controller.amendWork(params.parse(req.params).id,req.body as never)); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/work/:id/cancel',async(req,reply) => {
    try { empty.parse(req.query); return store.cancel(params.parse(req.params).id,req.body); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.get('/api/work/:id/events',async(req,reply) => {
    try { return store.events(params.parse(req.params).id,query(req.query)); }
    catch (error) { return projectFailure(reply,error); }
  });
}
