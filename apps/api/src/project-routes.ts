import type {FastifyInstance, FastifyReply} from 'fastify';
import {z} from 'zod';
import type {Storage} from './storage.js';
import {ProjectError, projectSchemas} from './project-store.js';
import {ProjectPaginationError} from './project-pagination.js';

const projectParams = z.object({id:z.string().min(1).max(100)}).strict();
const itemParams = projectParams.extend({itemId:z.string().min(1).max(100)}).strict();

// Fastify's query parser uses a framework prototype. Preserve every own key/raw
// value while adapting only that wrapper to the plain-JSON privacy boundary.
function queryRecord(value: unknown): Record<string,unknown> {
  return {...(value as Record<string,unknown>)};
}

export function projectFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof z.ZodError) return reply.code(400).send({error:'Invalid request'});
  if (error instanceof ProjectError) return reply.code(error.status).send({error:error.message,...('code' in error&&error.code==='LOCAL_SESSION_REQUIRED'?{code:error.code}:{})});
  if (error instanceof ProjectPaginationError) return reply.code(error.status).send({error:error.message,...(error.code ? {code:error.code} : {})});
  return reply.code(500).send({error:'Unable to complete this request. No change was applied.'});
}

export function registerProjects(app: FastifyInstance, storage: Storage): void {
  const registry = storage.registry;
  app.get('/api/workspace',async(req,reply) => {
    try { return registry.workspace(queryRecord(req.query) as never); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/workspace/access',async(req,reply) => {
    try { return registry.setAccess(req.body as never); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/projects',async(req,reply) => {
    try { return reply.code(201).send(registry.create(req.body as never)); }
    catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/projects/:id/settings',async(req,reply) => {
    try {
      z.object({}).strict().parse(req.query);
      const {id} = projectParams.parse(req.params);
      registry.validateContent(req.body);
      const input = projectSchemas.settings.parse(req.body);
      if (input.grant !== undefined) {
        registry.project(id);
        storage.sessions.require(req.headers.cookie);
      }
      return registry.updateSettings(id,input);
    } catch (error) { return projectFailure(reply,error); }
  });
  app.get('/api/projects/:id/overview',async(req,reply) => {
    try {
      const {id} = projectParams.parse(req.params);
      return registry.overview(id,queryRecord(req.query) as never);
    } catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/projects/:id/items',async(req,reply) => {
    try {
      const {id} = projectParams.parse(req.params);
      return reply.code(201).send(registry.saveItem(id,req.body as never));
    } catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/projects/:id/items/:itemId',async(req,reply) => {
    try {
      const {id,itemId} = itemParams.parse(req.params);
      return registry.saveItem(id,req.body as never,itemId);
    } catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/projects/:id/workflows',async(req,reply) => {
    try {
      const {id} = projectParams.parse(req.params);
      return reply.code(201).send(registry.saveWorkflow(id,req.body as never));
    } catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/workflows/:id/layout',async(req,reply) => {
    try {
      const {id} = projectParams.parse(req.params);
      return registry.saveLayout(id,req.body as never);
    } catch (error) { return projectFailure(reply,error); }
  });
  app.post('/api/projects/:id/repositories',async(req,reply) => {
    try {
      const {id} = projectParams.parse(req.params);
      return reply.code(201).send(registry.linkCandidate(id,req.body as never));
    } catch (error) { return projectFailure(reply,error); }
  });
}
