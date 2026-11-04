import test from 'node:test';
import assert from 'node:assert/strict';

const load = async () => {
  const module = await import('./verification-projection.ts').catch(()=>({}));
  assert.equal(typeof module.projectStepVerification,'function','shared server verification projection must exist');
  return module.projectStepVerification;
};
const record = (id,acceptanceId,outcome='passed',extra={})=>({id,projectId:'p',workId:'w',context:{projectId:'p',workflowId:'f',stepId:'s',specRevision:1,mapRevision:1},
  sourceClass:'test_runtime',sourceRevision:'abc',environment:'synthetic',checkedAt:'2026-01-01T00:00:00.000Z',acceptanceId,outcome,summary:'Synthetic evidence',executionBindingId:'binding',freshness:'current',staleReason:null,...extra});

test('unknown parent and empty evidence never label a project working', async()=>{
  const project=await load();
  assert.deepEqual(project({stepId:'s',requirementsKnown:false,requiredAcceptanceIds:[],evidence:[]}),{
    stepId:'s',verification:'not_checked',freshness:'unknown',lastCheckedAt:null,evidenceIds:[],reason:'Acceptance evidence is not available yet.',
  });
  assert.equal(project({stepId:'s',requirementsKnown:true,requiredAcceptanceIds:[],evidence:[record('e','a')]}).verification,'not_checked');
  assert.equal(project({stepId:'s',requirementsKnown:true,requiredAcceptanceIds:['a'],evidence:[]}).verification,'not_checked');
});

test('current complete runtime coverage verifies while failures and historical evidence cannot', async()=>{
  const project=await load();
  const input={stepId:'s',requirementsKnown:true,requiredAcceptanceIds:['a','b']};
  assert.equal(project({...input,evidence:[record('e1','a'),record('e2','b')]}).verification,'verified');
  assert.equal(project({...input,evidence:[record('e1','a')]}).verification,'checking');
  assert.equal(project({...input,evidence:[record('e1','a'),record('e2','b','failed')]}).verification,'failed');
  assert.equal(project({...input,evidence:[record('e1','a','passed',{sourceClass:'plan',executionBindingId:null})]}).verification,'not_checked');
  assert.equal(project({...input,evidence:[record('e1','a','passed',{executionBindingId:null})]}).verification,'not_checked');
});

test('late evidence is stale after source or grant revision changes', async()=>{
  const project=await load();
  for (const staleReason of ['Source revision changed.','Grant revision changed.']) {
    const result=project({stepId:'s',requirementsKnown:true,requiredAcceptanceIds:['a'],evidence:[record('e','a','passed',{freshness:'historical',staleReason})]});
    assert.equal(result.verification,'stale');
    assert.equal(result.freshness,'stale');
  }
});
