import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { registerDevTask } from './lib/dev-task.js'
import { analysisAccessProblem, bindDeliveryIntent, untrackedDelegationProblem } from './lib/delivery-access.js'
import { validateQuestions, sourceEvidence, deliveryView } from './lib/delivery-contract.js'
import { runDependencyBatch } from './lib/run-scheduler.js'
import { runMetrics } from './lib/investigation-runtime.js'

test('shipped ledger codec retains delivery evidence and separate parent/child cost records',async()=>{
  let registration,contribution
  runInNewContext(readFileSync('lib/client.js','utf8'),{window:{__ModuleLoader__:{load(value){registration=value}}}})
  // Stop at the remote mount; the host supplies React, and no component is rendered here.
  const client=registration.factory(()=>({}))
  const stop=new Error('remote captured')
  await assert.rejects(client.apply({remote:{$mount:async value=>{contribution=value;throw stop}}}),e=>e===stop)
  const metric={elapsed_ms:50,tool_calls:3,errors:1,input_tokens:null,cached_input_tokens:null,output_tokens:null}
  const at='2026-10-27T00:00:00Z'
  const delivery={version:1,intent:'analysis',reason:'diagnosis',created_at:at,metrics:metric,references:['chain.py'],runs:[{
    id:'run',run_id:'actual-child',parent_session:'parent',question:{id:'A',question:'trace mapping'},at,status:'returned',metrics:metric,
    report:{status:'complete',summary:'model omitted',evidence:[{file:'chain.py',start_line:1,end_line:2,quote:'source'}],limitations:[]},acceptance:'pending_parent',
  }],next_actions:['submit_analysis'],instruction:'inspect source'}
  delivery.result={conclusion:'mapping omitted',proposal:'copy model',limitations:[],accepted_at:at,evidence:[{file:'chain.py',start_line:1,end_line:2,quote:'full source range',highlight:'source',content_hash:'file-sha256',range_hash:'range-sha256'}]}
  const view={tasks:[{task_id:'A',title:'trace',stage:'调查分析',branch:'fixture',items:[{id:'I',title:'unit',status:'doing',
    dispatch:{description:'work',at,status:'completed',metrics:metric},independent_review:{status:'completed',at,parent_session:'parent',
      scope_hash:'scope',plan_key:'plan',dispatch_at:at,verification_at:at,metrics:metric}}],delivery}]}
  const remote=contribution.descriptors.find(d=>d.method==='readTasks')
  assert.deepEqual(JSON.parse(JSON.stringify(remote.result.create().parse(view))),view)
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-kernel-'))
  writeFileSync(join(cwd, 'chain.py'), 'def convert(data):\n    return {"batch": data["batch"]}\n')
  writeFileSync(join(cwd, 'a.mjs'), 'export const value = () => 2\n')
  writeFileSync(join(cwd, 'check.test.mjs'), "import{test}from'node:test';import assert from'node:assert/strict';import{value}from'./a.mjs';test('value',()=>assert.equal(value(),2));")
  const fs = { resolve: async (p, opts) => ({ targetKey: join(opts?.cwd ?? cwd, p) }),
    readText: async t => { try { return readFileSync(t.targetKey, 'utf8') } catch(e) { if(e.code!=='ENOENT')throw e } },
    lstat: async (p, opts) => { try { const s=lstatSync(join(opts?.cwd ?? cwd,p)); return {type:s.isFile()?'file':'directory',version:`${s.mtimeMs}:${s.size}`} } catch(e){if(e.code!=='ENOENT')throw e} },
    listDir: async t=>readdirSync(t.targetKey,{withFileTypes:true}).map(e=>({name:e.name,type:e.isFile()?'file':'directory'})),
    writeText: async(t,text)=>{mkdirSync(dirname(t.targetKey),{recursive:true});writeFileSync(t.targetKey,text)} }
  let execute, runtime
  const children=new Map(), guards=[]
  const ctx={fs, tools:{register(t){execute=t.execute},guard(fn){guards.push(fn)}},get:name=>name==='userQuestions'?{
    ask:async request=>({answers:request.questions.map(q=>({id:q.id,selected:['确认无误，继续']}))})
  }:name==='subagents'?runtime:name==='sessionQuery'?{
    observeSession:async id=>({header:{id},events:children.get(id)?.events??[],[Symbol.dispose](){}})
  }:name==='taskEngineReviewPolicy'?{preset:'task-engine-review',proof:id=>children.has(id)?{version:1,preset:'task-engine-review',child_id:id,tools:['read','grep','glob','structured_output']}:undefined}
    :name==='sandboxPolicy'?{resolve:()=>({mode:'workspace-write',workspaceRoot:cwd})}:name==='shell'?{resolve:r=>r,run:async spec=>{
      const env={...process.env};delete env.NODE_TEST_CONTEXT
      const r=spawnSync(process.execPath,['--test','--test-reporter=tap','check.test.mjs'],{cwd:spec.workdir,encoding:'utf8',env})
      return{exitCode:r.status,timedOut:false,aborted:false,stdout:{text:r.stdout},stderr:{text:r.stderr}}
    }}:undefined}
  registerDevTask(ctx)
  const agent={id:'parent',session:{id:'parent',header:{cwd},snapshotEvents:()=>[]}}
  const callRaw=args=>execute(args,{agent,signal:new AbortController().signal})
  const call=args=>callRaw({task_id:'KERNEL',...args})
  const state=()=>JSON.parse(readFileSync(join(cwd,'.dsh/task-KERNEL.json'),'utf8'))
  const confirmRequirement=async()=>{
    await call({operation:'record',artifact:'requirement',fields:{goal:'return value',scope:'local fixture',acceptance:'value returns 2'}})
    const summary=JSON.parse(await call({operation:'prepare_requirement'}))
    await call({operation:'confirm_requirement',expected_hash:summary.requirement.hash})
  }
  return {cwd,ctx,agent,guards,call,callRaw,state,children,confirmRequirement,set runtime(value){runtime=value}}
}
const claim={file:'chain.py',start_line:1,end_line:2,quote:'return {"batch": data["batch"]}'}
test('create reports missing contract fields before writing a task and allows a corrected retry',async()=>{
  const f=fixture()
  await assert.rejects(()=>f.callRaw({operation:'create',intent:'analysis'}),error=>{
    assert.match(error.message,/missing: task_id, title, intent_reason/)
    assert.match(error.message,/New-contract example:/)
    assert.match(error.message,/Branch is optional/)
    return true
  })
  assert.ok(!readdirSync(f.cwd).includes('.dsh'))
  await f.call({operation:'create',title:'Find a field mapping',intent:'analysis',intent_reason:'Diagnosis and proposal only'})
  assert.equal(f.state().delivery.intent,'analysis')
})

test('read-only analysis completes with source evidence and zero synthetic implementation/test gates',async()=>{
  const f=fixture()
  assert.match(f.guards[0]({agent:f.agent,name:'subagent',arguments:{}}),/Engineering delegation must be tracked/)
  await f.call({operation:'create',title:'Find why product model is lost and propose a fix',files:['chain.py'],intent:'analysis',intent_reason:'user requested diagnosis and proposal'})
  assert.equal(f.state().stage,'调查分析');assert.equal(f.state().verification_version,undefined)
  assert.equal(f.state().branch,'unversioned');assert.deepEqual(f.state().delivery.references,['chain.py']);assert.deepEqual(f.state().files,[])
  const created=f.state()
  await assert.rejects(()=>f.call({operation:'create',title:'replacement',branch:'test',intent:'implementation',intent_reason:'new work'}),/already exists/)
  assert.deepEqual(f.state(),created)
  assert.equal(analysisAccessProblem(f.agent,'write')?.includes('analysis-only'),true)
  await assert.rejects(()=>f.call({operation:'complete'}),/submit_analysis/)
  await assert.rejects(()=>f.call({operation:'verify'}),/analysis is read-only/)
  await assert.rejects(()=>f.call({operation:'submit_analysis',conclusion:'lost at conversion',proposal:'copy model',limitations:[],source_evidence:[{...claim,quote:'made up source'}]}),/does not match/)
  assert.equal(f.state().delivery.result,undefined)
  const accepted=JSON.parse(await f.call({operation:'submit_analysis',conclusion:'conversion only copies batch',proposal:'copy model from upstream and verify downstream',limitations:['runtime database not checked'],source_evidence:[claim]}))
  assert.equal(accepted.accepted,true);assert.equal(accepted.archived,true);assert.equal(accepted.delivery,undefined)
  assert.equal(accepted.evidence[0].quote,undefined);assert.match(f.state().delivery.result.evidence[0].quote,/return/)
  assert.ok(f.state().completed);assert.equal(f.state().files.length,0);assert.equal(f.state().items.length,0)
  assert.equal(f.state().verification.passed,false)
  assert.equal(f.state().delivery.result.evidence[0].content_hash.length,64)
  const snapshot=f.state().delivery.result.evidence[0]
  assert.equal(snapshot.quote,readFileSync(join(f.cwd,'chain.py'),'utf8').trimEnd())
  assert.equal(snapshot.highlight,claim.quote)
  assert.equal(snapshot.range_hash,createHash('sha256').update(snapshot.quote).digest('hex'))
  await assert.rejects(()=>f.call({operation:'submit_analysis'}),/archived/)
})
test('new implementation plans default direct, accept atomically only after a real test receipt',async()=>{
  const f=fixture();await f.call({operation:'create',title:'implementation',branch:'test',intent:'implementation',intent_reason:'user asked to implement',complexity:'low',complexity_reason:'bounded module'})
  await f.confirmRequirement()
  await f.call({operation:'load_skill',skill_name:'bundled:code-development'})
  const plan={id:'I1',title:'deliver value',files:['a.mjs','check.test.mjs'],acceptance:['value returns 2'],task_boundary:'independent',execution_reason:'small existing module; handoff offers no benefit'}
  await f.call({operation:'plan',plans:[plan]})
  assert.equal(f.state().items[0].execution_plan.mode,'direct');assert.equal(f.state().items[0].execution_plan.review,'main')
  await f.call({operation:'plan_verification',verification_group:'module',command:'node --test check.test.mjs',files:plan.files,item_ids:['I1']})
  await assert.rejects(()=>f.call({operation:'accept_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass',notes:['source checked']}),/verify|verification/)
  assert.equal(f.state().items[0].dispatch,undefined)
  await f.call({operation:'verify',verification_group:'module'})
  await f.call({operation:'accept_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass',notes:['value returns 2; node test executed']})
  assert.equal(f.state().items[0].status,'done');assert.ok(f.state().items[0].review.verification_key)
  writeFileSync(join(f.cwd,'a.mjs'),'export const value = () => 3\n')
  await assert.rejects(()=>f.call({operation:'accept_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/verify|stale|verification/)
})
test('bulk plan validation is atomic; directories and bad dependencies leave no partial changes',async()=>{
  const f=fixture();await f.call({operation:'create',title:'plan',branch:'test',intent:'implementation',intent_reason:'implement',complexity:'low',complexity_reason:'small'})
  await f.confirmRequirement()
  const before=f.state()
  await assert.rejects(()=>f.call({operation:'plan',plans:[{id:'I1',title:'bad',files:['.dsh'],acceptance:['works'],task_boundary:'local',execution_reason:'test'}]}),/non-regular/)
  assert.deepEqual(f.state(),before)
  await assert.rejects(()=>f.call({operation:'plan',plans:[{id:'I1',title:'bad',files:['a.mjs'],acceptance:['works'],depends_on:['I1'],task_boundary:'local',execution_reason:'test'}]}),/dependencies/)
  assert.deepEqual(f.state(),before)
})
test('native investigation batches overlap, preserve reports and refuse duplicate completed questions',async()=>{
  const f=fixture();await f.call({operation:'create',title:'trace field',branch:'test',intent:'analysis',intent_reason:'diagnosis only'})
  let active=0,peak=0,disposed=0
  f.runtime={getProvider:n=>({inheritsParentContext:n==='fork',capabilities:{depthLimit:true,agentPreset:true}}),startActivation:async spec=>{
    assert.equal(spec.request.agentPreset,'task-engine-review');assert.match(spec.request.prompt[0].text,/read-only investigator/)
    active++;peak=Math.max(peak,active);f.children.set(spec.childId,{events:[]})
    return {childId:spec.childId,result:new Promise(resolve=>setTimeout(()=>{active--;resolve({stopReason:'completed',output:[{type:'text',text:JSON.stringify({status:'complete',summary:'conversion omits model',evidence:[claim],limitations:[]})}]})},15)),dispose:async()=>{disposed++}}
  },listDescendants:async()=>[]}
  const args={operation:'delegate',delegation_benefit:'parallel',execution_reason:'two independent input adapters',questions:[{id:'A',question:'check input A'},{id:'B',question:'check input B'}]}
  await f.call(args);assert.equal(peak,2);assert.equal(disposed,2)
  assert.equal(f.state().delivery.runs.filter(r=>r.status==='returned').length,2);assert.equal(f.state().completed,undefined)
  await assert.rejects(()=>f.call(args),/already returned/)
  const {quote:unusedQuote,...location}=claim
  await f.call({operation:'submit_analysis',conclusion:'conversion omits model',proposal:'copy the field',limitations:[],source_evidence:[location]})
  assert.ok(deliveryView(f.state()).runs.every(run=>run.acceptance==='used_in_delivery'))
})
test('scheduler isolates failed dependencies and stops new launches after route authorization failure',async()=>{
  validateQuestions([{id:'A',question:'a'},{id:'B',question:'b',depends_on:['A']}])
  assert.throws(()=>validateQuestions([{id:'A',question:'a',depends_on:['B']},{id:'B',question:'b',depends_on:['A']}]),/cycle/)
  const ran=[],blocked=[];let auth
  await runDependencyBatch([{id:'A'},{id:'B'},{id:'C',depends_on:['A']}],1,new AbortController().signal,async q=>{ran.push(q.id);auth='AUTH';return false},async(q,reason)=>blocked.push([q.id,reason]),()=>auth)
  assert.deepEqual(ran,['A']);assert.equal(blocked.length,2)
})

test('native structured capture accepts a child report independently of commentary and fails closed if missing',async()=>{
  const f=fixture();await f.call({operation:'create',title:'trace',intent:'analysis',intent_reason:'diagnosis'})
  let captured=true
  f.runtime={getProvider:n=>({inheritsParentContext:n==='fork',capabilities:{depthLimit:true,agentPreset:true,outputSchema:true}}),startActivation:async spec=>{
    assert.ok(spec.request.outputSchema);f.children.set(spec.childId,{events:[]})
    return {childId:spec.childId,result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:'Confirmed the source finding.'}],
      ...(captured?{structured:{status:'complete',summary:'conversion omits model',evidence:[claim],limitations:[]}}:{})}),dispose:async()=>{}}
  },listDescendants:async()=>[]}
  const call=id=>f.call({operation:'delegate',delegation_benefit:'independent_check',execution_reason:'verify mapping',questions:[{id,question:'check conversion'}]})
  await call('A');assert.equal(f.state().delivery.runs[0].status,'returned');assert.equal(f.state().delivery.runs[0].report.summary,'conversion omits model')
  captured=false;await call('B');assert.equal(f.state().delivery.runs[1].status,'failed');assert.match(f.state().delivery.runs[1].error,/invalid investigation report/)
})
test('a completion during another blocked callback does not falsely report a dependency deadlock',async()=>{
  let release
  const gate=new Promise(resolve=>{release=resolve}), ran=[]
  await runDependencyBatch([{id:'C',depends_on:['B']},{id:'B'},{id:'A',depends_on:['F']},{id:'F'}],2,new AbortController().signal,
    async job=>{ran.push(job.id);if(job.id==='B')await gate;return job.id!=='F'},
    async job=>{if(job.id==='A'){release();await new Promise(resolve=>setImmediate(resolve))}})
  assert.ok(ran.includes('C'));assert.ok(!ran.includes('A'))
})
test('model AUTH failure preserves earlier findings and stops queued independent questions',async()=>{
  const f=fixture();await f.call({operation:'create',title:'trace',branch:'test',intent:'analysis',intent_reason:'read-only diagnosis'})
  let starts=0
  f.runtime={getProvider:n=>({inheritsParentContext:n==='fork',capabilities:{depthLimit:true,agentPreset:true}}),startActivation:async spec=>{
    starts++;f.children.set(spec.childId,{events:[]})
    return {childId:spec.childId,result:Promise.resolve(starts===1?{stopReason:'completed',output:[{type:'text',text:JSON.stringify({status:'complete',summary:'model dropped',evidence:[claim],limitations:[]})}]}:{stopReason:'error',diagnostic:'AUTH AccessDenied.Unpurchased',output:[]}),dispose:async()=>{}}
  },listDescendants:async()=>[]}
  await f.call({operation:'delegate',concurrency:1,delegation_benefit:'parallel',execution_reason:'independent adapters',questions:['A','B','C'].map(id=>({id,question:'check '+id}))})
  const runs=f.state().delivery.runs
  assert.equal(starts,2);assert.equal(runs[0].status,'returned');assert.ok(runs[0].report)
  assert.equal(runs[1].status,'failed');assert.equal(runs[2].status,'failed');assert.match(runs[2].error,/authorization/)
})
test('unproven cleanup keeps the task locked for acceptance; recovery requires host liveness',async()=>{
  const f=fixture();await f.call({operation:'create',title:'trace',branch:'test',intent:'analysis',intent_reason:'diagnose'})
  let active=true
  f.runtime={getProvider:n=>({inheritsParentContext:n==='fork',capabilities:{depthLimit:true,agentPreset:true}}),startActivation:async spec=>{
    f.children.set(spec.childId,{events:[]})
    return {childId:spec.childId,result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:JSON.stringify({status:'complete',summary:'found',evidence:[claim],limitations:[]})}]}),dispose:async()=>{throw Error('cleanup failed')}}
  },listDescendants:async()=>f.state().delivery.runs.filter(r=>r.run_id).map(r=>({id:r.run_id,kind:'child',activity:active?'active':'inactive',parentId:'parent',depth:1}))}
  await f.call({operation:'delegate',delegation_benefit:'independent_check',execution_reason:'verify disputed mapping',questions:[{id:'A',question:'check conversion'}]})
  assert.equal(f.state().delivery.runs[0].status,'running');assert.ok(f.state().delivery.runs[0].report)
  await assert.rejects(()=>f.call({operation:'submit_analysis',conclusion:'found',proposal:'fix',limitations:[],source_evidence:[claim]}),/active/)
  await assert.rejects(()=>f.call({operation:'recover_analysis'}),/still active/)
  active=false;await f.call({operation:'recover_analysis'})
  assert.equal(f.state().delivery.runs[0].status,'failed');assert.ok(f.state().delivery.runs[0].report)
})
test('analysis guard is per-agent; source windows and usage counters do not fabricate proof',()=>{
  const a={},b={};bindDeliveryIntent(a,'analysis')
  assert.equal(analysisAccessProblem(a,'grep'),undefined);assert.ok(analysisAccessProblem(a,'run_code'))
  assert.match(untrackedDelegationProblem('subagent'),/dev_task delegate/);assert.match(untrackedDelegationProblem('subagent_spawn'),/tracked/)
  assert.ok(analysisAccessProblem(a,'dev_task',{operation:'init',phase:'apply'}));assert.equal(analysisAccessProblem(a,'dev_task',{operation:'status'}),undefined)
  assert.equal(analysisAccessProblem(b,'write'),undefined);bindDeliveryIntent(a,'implementation');assert.equal(analysisAccessProblem(a,'write'),undefined)
  assert.throws(()=>sourceEvidence({...claim,end_line:1},'one line','hash'),/does not match/)
  const m=runMetrics([{type:'assistant/message',data:{stream:[{chunk:{type:'usage',usage:{inputTokens:3,cacheReadTokens:20,outputTokens:2}}}]}},{type:'tool/call',seq:4,data:{}},{type:'tool/call',seq:4,data:{}}],Date.now())
  assert.equal(m.tool_calls,1);assert.equal(m.input_tokens,3);assert.equal(m.cached_input_tokens,20);assert.equal(m.output_tokens,2)
  assert.equal(runMetrics([],Date.now()).input_tokens,null)
  const source='def convert(data):\n    return {"batch": data["batch"]}\n'
  const {quote:omitted,...location}=claim
  assert.equal(sourceEvidence(location,source,'hash').quote,source.trimEnd())
  assert.throws(()=>sourceEvidence({...location,end_line:30},source,'hash'),/does not match/)
  assert.throws(()=>sourceEvidence({...location,end_line:300},source,'hash'),/at most 200/)
})
