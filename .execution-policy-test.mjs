import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { registerDevTask } from './lib/dev-task.js'
import { executionCapabilities, fullReadCoverage, makeExecutionPlan, parseIndependentReview } from './lib/execution-plan.js'
import { todosBlockers } from './lib/engine.js'

const all = { spawn: true, fork: true, reviewer: true }
const none = { spawn: false, fork: false, reviewer: false }
const planInput = { execution_reason: '明确的文件范围、接口和可独立验证的交付', task_boundary: 'independent', files: ['a.mjs','check.test.mjs'], acceptance: ['value() 返回 2'] }
async function fixture({ legacy = false, policy = 'auto' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'task-execution-policy-'))
  writeFileSync(join(cwd, 'a.mjs'), 'export const value = () => 2\n')
  writeFileSync(join(cwd, 'check.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert/strict';import{value}from'./a.mjs';test('delivered value',()=>assert.equal(value(),2));")
  const fs = { resolve: async (p, opts) => ({ targetKey: join(opts?.cwd ?? cwd, p) }),
    readText: async t => { try { return readFileSync(t.targetKey, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e } },
    lstat: async (p, opts) => { try { const s = lstatSync(join(opts?.cwd ?? cwd, p)); return { type: s.isFile() ? 'file' : 'directory', version: `${s.mtimeMs}:${s.size}` } } catch(e) { if(e.code !== 'ENOENT') throw e } },
    listDir: async t => readdirSync(t.targetKey, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isFile() ? 'file' : 'directory' })),
    writeText: async (t, text) => { mkdirSync(dirname(t.targetKey), {recursive:true}); writeFileSync(t.targetKey, text) } }
  let execute, runtime
  const children = new Map()
  const query = { observeSession: async id => ({header:{id}, events: children.get(id)?.() ?? [], [Symbol.dispose]() {}}) }
  const reviewerPolicy = {preset:"task-engine-review", proof: id => children.has(id) ? {version:1,preset:"task-engine-review",child_id:id,tools:["read","structured_output"]} : undefined}
  const ctx = { fs, tools: { register(tool) { execute = tool.execute } }, get: name => name === 'subagents' ? runtime : name === 'sessionQuery' ? query : name === 'taskEngineReviewPolicy' ? reviewerPolicy : name === 'sandboxPolicy' ? { resolve: () => ({mode:'workspace-write',workspaceRoot:cwd}) }
    : name === 'shell' ? { resolve: r => r, run: async spec => {
      const env = {...process.env}; delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, ['--test','--experimental-test-isolation=none','--test-reporter=tap','check.test.mjs'], {cwd:spec.workdir,encoding:'utf8',env})
      return {exitCode:r.status,timedOut:false,aborted:false,stdout:{text:r.stdout},stderr:{text:r.stderr}} } } : undefined }
  registerDevTask(ctx)
  const session = {id:'parent',header:{cwd},snapshotEvents:()=>[]}
  const call = args => execute({task_id:'POLICY-1',...args},{agent:{session},signal:new AbortController().signal})
  await call({operation:'create', title:'execution strategy test',branch:'test',files:['a.mjs','check.test.mjs'],
    ...legacy ? {} : {complexity:'low',complexity_reason:'bounded module',execution_policy:policy},items:[{id:'I1',title:'deliver module'}]})
  if (!legacy) await call({operation:'plan_verification',verification_group:'module',command:'node --test check.test.mjs',files:['a.mjs','check.test.mjs'],item_ids:['I1']})
  const taskPath = join(cwd,'.dsh/task-POLICY-1.json')
  const state = () => JSON.parse(readFileSync(taskPath,'utf8'))
  const save = s => writeFileSync(taskPath,JSON.stringify(s))
  let verdict = {spec:'pass',quality:'pass',notes:['a.mjs:1 returns 2; check.test.mjs:1 pins acceptance']}, disposed=0, calls=[]
  runtime = { getProvider: name => ({inheritsParentContext:name==='fork',capabilities:{depthLimit:true,agentPreset:true}}),
    startActivation: async spec => {
      const provider=spec.provider, request={...spec.request,label:spec.label,signal:spec.signal}
      assert.equal(spec.delivery,'caller');assert.equal(spec.request.cwd,cwd)
      const reviewer = request.label.endsWith('/review')
      calls.push({provider,reviewer,request,spec})
      if (reviewer) { assert.equal(request.agentPreset,'task-engine-review');assert.equal(request.toolFilter,undefined);assert.match(request.prompt[0].text,/Applicable project Skills and Rules/);assert.match(request.prompt[0].text,/code-development/);assert.match(request.prompt[0].text,/code-review/) }
      const childId=reviewer?'review-child':'implementation-child'
      children.set(childId,()=>reviewer?state().items[0].execution_plan.files.flatMap((file,index)=>{
        const lines=readFileSync(join(cwd,file),'utf8').split('\n');if(lines.at(-1)==='')lines.pop()
        const content=`<path>${join(cwd,file)}</path>\n<type>file</type>\n<content>\n${lines.map((text,i)=>`${i+1}: ${text}`).join('\n')}${lines.length?'\n\n':''}(End of file - total ${lines.length} lines)\n</content>`
        return [{type:'tool/call',data:{name:'read',callId:`read-${index}`,arguments:JSON.stringify({file_path:file})}},
          {type:'tool/result',data:{message:{toolCallId:`read-${index}`,isError:false,content:[{type:'text',text:content}]}}}]
      }):[])
      return {childId, result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:reviewer?JSON.stringify(verdict):'a.mjs delivered'}]}),dispose:async()=>{disposed++}}
    }, listDescendants:async()=>[{id:'review-child',kind:'child',parentId:'parent',depth:1,activity:'inactive'}] }
  return {cwd,fs,ctx,call,state,save,calls,query,children,get runtime(){return runtime},set runtime(v){runtime=v},set verdict(v){verdict=v},get disposed(){return disposed}}
}
test('automatic routing uses boundaries, context needs and actual host availability', () => {
  const state = {items:[{id:'I1'}],files:['a.mjs','check.test.mjs'],complexity:'medium',risk_level:'standard'}
  const item = state.items[0]
  assert.equal(makeExecutionPlan(state,item,{...planInput,task_boundary:'local'},all).mode,'direct')
  assert.equal(makeExecutionPlan(state,item,planInput,all).mode,'spawn')
  assert.equal(makeExecutionPlan(state,item,{...planInput,context_need:'history'},all).mode,'fork')
  const fallback=makeExecutionPlan(state,item,planInput,none)
  assert.equal(fallback.mode,'direct');assert.match(fallback.reason,/不可用/)
  assert.throws(()=>makeExecutionPlan(state,item,{...planInput,execution:'spawn'},none),/unavailable/)
  assert.equal(makeExecutionPlan({...state,execution_policy:'main_only'},item,planInput,all).mode,'direct')
  assert.throws(()=>makeExecutionPlan(state,item,{...planInput,depends_on:['I1']},all),/earlier/)
  assert.throws(()=>makeExecutionPlan(state,item,{...planInput,files:['outside']},all),/scope/)
})
test('native working_directory cd does not relocate the task ledger or delegated delivery root', async () => {
  const f=await fixture();const get=f.ctx.get
  f.ctx.get=name=>name==='workingDirectory'?{ensure:async()=>join(f.cwd,'nested')}:get(name)
  await f.call({operation:'plan_execution',item_id:'I1',...planInput})
  await f.call({operation:'dispatch',item_id:'I1'})
  assert.equal(f.state().root,f.cwd)
  assert.equal(f.calls[0].spec.request.cwd,f.cwd)
})
test('capability detection does not mistake a start method for a registered independent provider', () => {
  assert.deepEqual(executionCapabilities({get:()=>({start(){}})},true),none)
  assert.equal(executionCapabilities({get:()=>({start(){},getProvider(){return {inheritsParentContext:true,capabilities:{agentPreset:true}}}})},true).spawn,false)
  assert.deepEqual(executionCapabilities({get:()=>({start(){},getProvider(name){return {inheritsParentContext:name==='fork',capabilities:{agentPreset:true}}}})},true),none)
})
test('dispatch rechecks mandatory depth capability before changing item state or starting a child', async () => {
  const f=await fixture();await f.call({operation:'plan_execution',item_id:'I1',...planInput})
  f.runtime.getProvider=name=>({inheritsParentContext:name==='fork',capabilities:{agentPreset:true}})
  await assert.rejects(()=>f.call({operation:'dispatch',item_id:'I1'}),/depthLimit/)
  assert.equal(f.state().items[0].status,'todo');assert.equal(f.state().items[0].dispatch,undefined);assert.equal(f.calls.length,0)
})
test('native structured review uses the committed host value, not conflicting assistant text', async () => {
  const f=await fixture();const getProvider=f.runtime.getProvider;f.runtime.getProvider=name=>({...getProvider(name),capabilities:{depthLimit:true,agentPreset:true,outputSchema:true}})
  const start=f.runtime.startActivation
  f.runtime.startActivation=async spec=>{
    const request={...spec.request,label:spec.label,signal:spec.signal}
    const run=await start(spec)
    if(request.label.endsWith('/review')){
      assert.equal(request.outputSchema.additionalProperties,false)
      assert.match(request.prompt[0].text,/Finish by calling the host structured_output/)
      run.result=run.result.then(result=>({...result,structured:{spec:'fail',quality:'fail',notes:['a.mjs:1 needs correction']}}))
    }else assert.equal(request.outputSchema,undefined)
    return run
  }
  await f.call({operation:'plan_execution',item_id:'I1',...planInput});await f.call({operation:'dispatch',item_id:'I1'})
  await f.call({operation:'verify',command:'node --test check.test.mjs'});await f.call({operation:'review_dispatch',item_id:'I1'})
  assert.equal(f.state().items[0].independent_review.spec,'fail')
  await assert.rejects(()=>f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/cannot override/)
})
test('requested native capture cannot fall back to text when missing or invalid; cancellation releases its run', async () => {
  for(const outcome of ['missing','invalid','aborted']){
    const f=await fixture();const getProvider=f.runtime.getProvider;f.runtime.getProvider=name=>({...getProvider(name),capabilities:{depthLimit:true,agentPreset:true,outputSchema:true}})
    const start=f.runtime.startActivation
    f.runtime.startActivation=async spec=>{
      const request={...spec.request,label:spec.label,signal:spec.signal}
      assert.equal(request.signal instanceof AbortSignal,true)
      const run=await start(spec)
      if(request.label.endsWith('/review'))run.result=run.result.then(result=>({...result,...outcome==='aborted'?{stopReason:'aborted'}:outcome==='invalid'?{structured:{spec:'pass',quality:'pass',notes:[]}}:{}}))
      return run
    }
    await f.call({operation:'plan_execution',item_id:'I1',...planInput});await f.call({operation:'dispatch',item_id:'I1'})
    await f.call({operation:'verify',command:'node --test check.test.mjs'});await f.call({operation:'review_dispatch',item_id:'I1'})
    assert.equal(f.state().items[0].independent_review.status,'failed');assert.equal(f.disposed,2)
    await assert.rejects(()=>f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/independent review/)
  }
})
test('new adaptive work requires a recorded plan; local work stays in the main session', async () => {
  const f=await fixture()
  await assert.rejects(()=>f.call({operation:'dispatch',item_id:'I1'}),/plan_execution/)
  await f.call({operation:'plan_execution',item_id:'I1',...planInput,task_boundary:'local'})
  await f.call({operation:'dispatch',item_id:'I1'})
  assert.equal(f.state().items[0].dispatch.execution,'direct');assert.equal(f.calls.length,0)
})
test('automatic child implementation requires an independent verdict and real parent verification', async () => {
  const f=await fixture()
  await f.call({operation:'plan_execution',item_id:'I1',...planInput})
  await f.call({operation:'dispatch',item_id:'I1'})
  assert.equal(f.calls[0].provider,'spawn');assert.equal(f.state().items[0].status,'doing')
  await assert.rejects(()=>f.call({operation:'review_dispatch',item_id:'I1'}),/verify/)
  await assert.rejects(()=>f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/independent review/)
  await f.call({operation:'verify',command:'node --test check.test.mjs'})
  await f.call({operation:'review_dispatch',item_id:'I1'})
  await f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'})
  await f.call({operation:'items',items:[{id:'I1',status:'done'}]})
  assert.equal(f.disposed,2);assert.equal(f.state().items[0].review.independent_run_id,'review-child')
  writeFileSync(join(f.cwd,'a.mjs'),'export const value = () => 2 // amended\n')
  await assert.rejects(()=>f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/stale/)
})
test('parent cannot replace independent failures with a self-reported pass', async () => {
  const f=await fixture();f.verdict={spec:'fail',quality:'fail',notes:['a.mjs:1 requires correction']}
  await f.call({operation:'plan_execution',item_id:'I1',...planInput});await f.call({operation:'dispatch',item_id:'I1'})
  await f.call({operation:'verify',command:'node --test check.test.mjs'});await f.call({operation:'review_dispatch',item_id:'I1'})
  await assert.rejects(()=>f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/cannot override/)
  await f.call({operation:'review_item',item_id:'I1',spec_outcome:'fail',quality_outcome:'fail'})
  await assert.rejects(()=>f.call({operation:'items',items:[{id:'I1',status:'done'}]}),/independent review/)
})
test('unavailable host selects an explicit main-session fallback; legacy records remain executable', async () => {
  const f=await fixture();f.runtime=undefined
  await f.call({operation:'plan_execution',item_id:'I1',...planInput})
  assert.equal(f.state().items[0].execution_plan.mode,'direct');assert.match(f.state().items[0].execution_plan.reason,/不可用/)
  const legacy=await fixture({legacy:true});const state=legacy.state();state.stage='开发';legacy.save(state)
  await legacy.call({operation:'dispatch',item_id:'I1'});assert.equal(legacy.state().items[0].status,'doing')
})
test('malformed reviewer output and fabricated acceptance metadata do not close the item', async () => {
  assert.throws(()=>parseIndependentReview('looks good'))
  assert.throws(()=>parseIndependentReview('{"spec":"pass","quality":"pass","notes":[]}'))
  const f=await fixture();await f.call({operation:'plan_execution',item_id:'I1',...planInput})
  const s=f.state();s.items[0].status='done';s.items[0].review={spec:{outcome:'pass'},quality:{outcome:'pass'}}
  assert.match(todosBlockers(s,s.flow.config).join(' '),/independent review/)
})
test('reviewer must actually read the planned files; disposal failure stays locked until host recovery', async () => {
  const f=await fixture();await f.call({operation:'plan_execution',item_id:'I1',...planInput});await f.call({operation:'dispatch',item_id:'I1'})
  await f.call({operation:'verify',command:'node --test check.test.mjs'})
  const start=f.runtime.startActivation
  f.runtime.startActivation=async(...args)=>{const run=await start(...args);f.children.set(run.childId,()=>[]);return run}
  await f.call({operation:'review_dispatch',item_id:'I1'})
  assert.match(f.state().items[0].independent_review.error,/read every/)
  f.runtime.startActivation=async(...args)=>{const run=await start(...args);run.dispose=async()=>{throw new Error('cleanup failed')};return run}
  await f.call({operation:'review_dispatch',item_id:'I1'})
  assert.equal(f.state().items[0].independent_review.status,'running')
  await assert.rejects(()=>f.call({operation:'items',items:[{id:'I1',status:'done'}]}),/still active/)
  await f.call({operation:'recover_dispatch',item_id:'I1',dispatch_role:'review'})
  assert.equal(f.state().items[0].independent_review.status,'failed');assert.equal(f.state().items[0].status,'doing')
})
test('orchestration cannot hand off unplanned items and dependencies block early dispatch', async () => {
  const f=await fixture();const s=f.state();s.complexity='high';s.stage='任务编排';
  s.artifacts['task-plan']={steps:'- I1 module',dependencies:'none',handoffs:'module and tests'};f.save(s)
  await assert.rejects(()=>f.call({operation:'advance',target_stage:'代码开发'}),/plan_execution/)
  await f.call({operation:'plan_execution',item_id:'I1',...planInput})
  assert.equal(f.state().items[0].execution_plan.review,'independent')
  const t=f.state();t.stage='代码开发';t.items.push({id:'I2',title:'dependent',status:'todo'});f.save(t)
  await f.call({operation:'plan_execution',item_id:'I2',...planInput,depends_on:['I1']})
  await assert.rejects(()=>f.call({operation:'dispatch',item_id:'I2'}),/dependencies/)
})

test('infrastructure failures do not consume verdict budget and failed re-review reopens acceptance', async () => {
  const f=await fixture();await f.call({operation:'plan_execution',item_id:'I1',...planInput});await f.call({operation:'dispatch',item_id:'I1'})
  await f.call({operation:'verify',command:'node --test check.test.mjs'})
  const start=f.runtime.startActivation
  f.runtime.startActivation=async()=>{throw new Error('temporary startup failure')}
  for(let i=0;i<4;i++)await f.call({operation:'review_dispatch',item_id:'I1'})
  assert.equal(f.state().items[0].independent_review.run_id,undefined)
  f.runtime.startActivation=start
  await f.call({operation:'review_dispatch',item_id:'I1'});await f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'});await f.call({operation:'items',items:[{id:'I1',status:'done'}]})
  f.runtime.startActivation=async()=>{throw new Error('temporary startup failure')}
  await f.call({operation:'review_dispatch',item_id:'I1'})
  assert.equal(f.state().items[0].status,'doing');assert.equal(f.state().items[0].review,undefined)
  f.runtime.startActivation=start
  await f.call({operation:'review_dispatch',item_id:'I1'});await f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'});await f.call({operation:'items',items:[{id:'I1',status:'done'}]})
})
test('three completed verdicts cap only the same code, dispatch, plan and constraint context', async () => {
  const f=await fixture();await f.call({operation:'plan_execution',item_id:'I1',...planInput});await f.call({operation:'dispatch',item_id:'I1'});await f.call({operation:'verify',command:'node --test check.test.mjs'})
  for(let i=0;i<3;i++)await f.call({operation:'review_dispatch',item_id:'I1'})
  await assert.rejects(()=>f.call({operation:'review_dispatch',item_id:'I1'}),/three completed/)
  const s=f.state();s.artifacts={'changed-requirement':{scope:'new acceptance context'}};f.save(s)
  await assert.rejects(()=>f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/context changed/)
  await f.call({operation:'review_dispatch',item_id:'I1'})
  assert.equal(f.state().items[0].independent_review.status,'completed')
})
test('full read evidence requires all current lines; gaps, stale and truncated text fail, windows and empty files work', () => {
  const key=x=>x
  const events=(text,id='r',error=false)=>[
    {type:'tool/call',data:{name:'read',callId:id,arguments:JSON.stringify({file_path:'a'})}},
    {type:'tool/result',data:{message:{toolCallId:id,isError:error,content:[{type:'text',text:`<path>a</path>\n<type>file</type>\n<content>\n${text}\n</content>`}]}}}]
  const files=[{file:'a',content:'first\nsecond\nthird\n'}]
  assert.deepEqual(fullReadCoverage(events('1: first'),files,key),[])
  assert.deepEqual(fullReadCoverage(events('1: first\n2: wrong\n3: third'),files,key),[])
  assert.deepEqual(fullReadCoverage(events('1: first\n2: sec... (line truncated to 3 chars)\n3: third'),files,key),[])
  assert.deepEqual(fullReadCoverage([...events('1: first\n2: second','one'),...events('2: second\n3: third','two')],files,key),[{file:'a',lines:3}])
  assert.deepEqual(fullReadCoverage(events('1: first\n2: second\n3: third','bad',true),files,key),[])
  assert.deepEqual(fullReadCoverage(events('(End of file - total 0 lines)'),[{file:'a',content:''}],key),[{file:'a',lines:0}])
  assert.deepEqual(fullReadCoverage(events('1: unicode\u2028separator\n2: last'),[{file:'a',content:'unicode\u2028separator\r\nlast\r\n'}],key),[{file:'a',lines:2}])
})
test('partial successful reads cannot authorize a real item, and a later full read can recover', async () => {
  const f=await fixture();writeFileSync(join(f.cwd,'a.mjs'),'export const value = () => 2\n'+'// still needs review\n'.repeat(100))
  await f.call({operation:'plan_execution',item_id:'I1',...planInput});await f.call({operation:'dispatch',item_id:'I1'});await f.call({operation:'verify',command:'node --test check.test.mjs'})
  const start=f.runtime.startActivation
  f.runtime.startActivation=async(...args)=>{const run=await start(...args);f.children.set(run.childId,()=>[
    {type:'tool/call',data:{name:'read',callId:'partial',arguments:JSON.stringify({file_path:'a.mjs',offset:1,limit:1})}},
    {type:'tool/result',data:{message:{toolCallId:'partial',content:[{type:'text',text:'<path>a.mjs</path>\n<type>file</type>\n<content>\n1: export const value = () => 2\n\n(Showing lines 1-1 of 101.)\n</content>'}]}}}]);return run}
  await f.call({operation:'review_dispatch',item_id:'I1'});assert.equal(f.state().items[0].independent_review.status,'failed')
  await assert.rejects(()=>f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/independent review/)
  f.runtime.startActivation=start;await f.call({operation:'review_dispatch',item_id:'I1'});assert.equal(f.state().items[0].independent_review.read_coverage[0].lines,101)
})
test('unowned task files block implementation and adaptive main-session done requires current tests and review', async () => {
  const f=await fixture();await f.call({operation:'plan_execution',item_id:'I1',...planInput,files:['a.mjs']})
  await assert.rejects(()=>f.call({operation:'dispatch',item_id:'I1'}),/no implementation-plan owner/)
  await f.call({operation:'plan_execution',item_id:'I1',...planInput,task_boundary:'local'});await f.call({operation:'dispatch',item_id:'I1'})
  await assert.rejects(()=>f.call({operation:'items',items:[{id:'I1',status:'done'}]}),/review is missing/)
  await assert.rejects(()=>f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'}),/verify/)
  await f.call({operation:'verify',command:'node --test check.test.mjs'});await f.call({operation:'review_item',item_id:'I1',spec_outcome:'pass',quality_outcome:'pass'});await f.call({operation:'items',items:[{id:'I1',status:'done'}]})
  writeFileSync(join(f.cwd,'a.mjs'),'export const value = () => 2 // changed\n')
  await assert.rejects(()=>f.call({operation:'items',items:[{id:'I1',status:'done'}]}),/verify/)
  await f.call({operation:'verify',command:'node --test check.test.mjs'})
  await assert.rejects(()=>f.call({operation:'items',items:[{id:'I1',status:'done'}]}),/review.*stale/)
})
test('same-task concurrent dispatch admits one child and releases mutation guard on failures', async () => {
  const f=await fixture();await f.call({operation:'plan_execution',item_id:'I1',...planInput})
  const start=f.runtime.startActivation;let entered=0,release
  const wait=new Promise(resolve=>release=resolve)
  f.runtime.startActivation=async(...args)=>{entered++;const run=await start(...args);run.result=wait.then(()=>({stopReason:'completed',output:[]}));return run}
  const pending=f.call({operation:'dispatch',item_id:'I1'})
  await assert.rejects(()=>f.call({operation:'dispatch',item_id:'I1'}),/mutation is in progress/)
  await f.call({operation:'status'});release();await pending;assert.equal(entered,1)
  await assert.rejects(()=>f.call({operation:'plan_execution',item_id:'I1',...planInput}),/reopen/)
  await f.call({operation:'status'})
})
