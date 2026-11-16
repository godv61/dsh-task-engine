// Real public-SDK children driven by a local scripted adapter; no external API.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeTool } from './tool-runtime.mjs'
import { startTaskActivation, ownActivation } from './node_modules/@godv61/dsh-task-engine/lib/subagent-runtime.js'

export const name='task-engine-keyless-activation-probe'
export const inject=['llm','subagents','agentPresets','tools']
function response(text) {
  return [{type:'block-start',index:0,blockType:'text'}, {type:'text-delta',index:0,text},
    {type:'block-end',index:0,block:{type:'text',text}}, {type:'finish',reason:{kind:'stop'}}]
}
function tool(id,name,args) {
  const callId=ToolCallId(id),json=JSON.stringify(args)
  return [{type:'block-start',index:0,blockType:'tool-call'},
    {type:'tool-call-delta',index:0,id:callId,name,argumentsDelta:json},
    {type:'block-end',index:0,block:{type:'tool-call',id:callId,name,arguments:json}},
    {type:'finish',reason:{kind:'tool-calls'}}]
}
export function apply(ctx) {
  let scriptedCalls=0,readStep=0,signalStarted
  const started=new Promise(resolve=>{signalStarted=resolve})
  class ScriptedAdapter extends LlmAdapter {
    async resolveModel(provider,model) { return {provider,id:model,name:model} }
    async *stream(options) {
      scriptedCalls++
      const input=JSON.stringify(options.messages)
      if(input.includes('ACTIVATION_CANCEL')) {
        signalStarted()
        await new Promise((resolve,reject)=>{
          if(options.signal?.aborted) return reject(new Error('fixture cancelled'))
          options.signal?.addEventListener('abort',()=>reject(new Error('fixture cancelled')),{once:true})
        })
        return
      }
      let chunks
      if(input.includes('ACTIVATION_READ')) {
        const step=readStep++
        assert.ok(step<3,'investigator must finish without retry loops')
        chunks=step===0?tool('denied-write','write',{file_path:'forbidden-activation.txt',content:'must not write'})
          :step===1?tool('source-read','read',{file_path:'proof.txt'})
          :tool('source-report','structured_output',{status:'complete',summary:'Fixture source was read through the readonly child',
            evidence:[{file:'proof.txt',start_line:1,end_line:1,quote:'Native preset composition fixture'}],limitations:[]})
      } else {
        assert.match(input,/ACTIVATION_(SPAWN|FORK|AFTER_CANCEL)/)
        chunks=response('Managed child completed')
      }
      yield* chunks
    }
  }
  ctx.llm.registerAdapter(['activation-fixture'],new ScriptedAdapter())
  ctx.on('agent/created',async({agent})=>{
    if(agent.id!=='preset-activation-fixture')return
    // This root never asks a model to make decisions; invoke the actual tool.
    await ctx.agentPresets.select(agent,'eng')
    const invoke=async args=>{
      const result=await executeTool(agent.ctx,{name:'dev_task',arguments:{task_id:'ACTIVATION-PROBE',...args},
        agent,signal:AbortSignal.timeout(20000),callId:ToolCallId(`activation-${args.operation}`)})
      assert.equal(result.isError,false,JSON.stringify(result))
      return result
    }
    await invoke({operation:'create',title:'Actual managed activation probe',intent:'analysis',intent_reason:'Keyless runtime compatibility check'})
    await invoke({operation:'delegate',delegation_benefit:'independent_check',execution_reason:'Verify a real isolated readonly child',
      questions:[{id:'SDK-READ',question:'ACTIVATION_READ: inspect proof.txt and cite its first line'}]})
    const cwd=agent.session.header.cwd
    const state=JSON.parse(readFileSync(join(cwd,'.dsh/tasks/ACTIVATION-PROBE/task.json'),'utf8'))
    const run=state.delivery.runs.find(run=>run.question.id==='SDK-READ')
    assert.equal(run?.status,'returned',JSON.stringify(run))
    assert.equal(run.run_id,run.id,'the reserved child session identity must survive dispatch')
    assert.equal(run.report.status,'complete')
    assert.equal(run.report.evidence[0].file,'proof.txt')
    assert.ok(!state.completed,'child completion must not accept the parent analysis')
    assert.ok(!existsSync(join(cwd,'forbidden-activation.txt')),'readonly child must deny actual writes')
    await invoke({operation:'submit_analysis',conclusion:'Readonly managed activation succeeded',proposal:'No business change',limitations:[],
      source_evidence:run.report.evidence})
    await ctx.agentPresets.select(agent,'standard')
    const identities=[]
    async function start(provider,marker,signal=AbortSignal.timeout(15000)) {
      const childId=SessionId(`fixture-${marker.toLowerCase()}`)
      const handle=ownActivation(await startTaskActivation(ctx.subagents,{provider,label:`SDK/${marker}`,childId,
        signal,delivery:'caller',parent:agent,cwd,maxDepth:1,agentOptions:{provider:'activation-fixture',model:'offline'},
        prompt:[{type:'text',text:marker}]}),signal)
      assert.equal(handle.childId,childId)
      if(typeof ctx.subagents.namesOf==='function')assert.equal(typeof handle.name,'string')
      identities.push(childId)
      return handle
    }
    for(const [provider,marker] of [['spawn','ACTIVATION_SPAWN'],['fork','ACTIVATION_FORK']]) {
      const handle=await start(provider,marker)
      try { assert.equal((await handle.result).stopReason,'completed') }
      finally { await handle.dispose() }
    }
    const controller=new AbortController()
    const cancelled=await start('spawn','ACTIVATION_CANCEL',controller.signal)
    try {
      await Promise.race([started,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('child did not start')),10000);t.unref()})])
      // Attach before abort so a prompt cancellation cannot become unhandled.
      const settled=cancelled.result.then(result=>assert.notEqual(result.stopReason,'completed','cancelled work must never complete successfully'),
        error=>assert.match(String(error),/parent cancelled child activation/))
      controller.abort()
      await settled
    } finally { await cancelled.dispose() }
    const resumed=await start('spawn','ACTIVATION_AFTER_CANCEL')
    try { assert.equal((await resumed.result).stopReason,'completed') }
    finally { await resumed.dispose() }
    const children=await ctx.subagents.listDescendants(agent.session.id)
    for(const id of [run.run_id,...identities]) {
      const child=children.find(child=>child.id===id)
      assert.ok(child,`child must remain observable: ${id}`)
      assert.equal(child.activity,'inactive',`no active child may leak: ${id}`)
    }
    writeFileSync(process.env.TASK_ENGINE_ACTIVATION_PROBE_RESULT,JSON.stringify({external_model_calls:0,scripted_calls:scriptedCalls,
      delegate_returned:true,stable_child_ids:true,readonly_write_denied:true,parent_acceptance_separate:true,
      spawn:true,fork:true,cancellation:true,dispatch_after_cancellation:true,children_inactive:true},null,2))
  })
}
