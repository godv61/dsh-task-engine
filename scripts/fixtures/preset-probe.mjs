// Loaded only by verify-host-preset; no credentials and no model requests.
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name='task-engine-keyless-preset-probe'
export const inject=['llm','agentPresets','tools','systemPrompt']
export function apply(ctx){
  let modelCalls=0,created=0
  const observations=[]
  class OfflineAdapter extends LlmAdapter{
    async *generate(){modelCalls++;throw new Error('Keyless preset test must not call a model')}
  }
  ctx.llm.registerAdapter(['preset-fixture'],new OfflineAdapter())
  ctx.on('agent/created',async({agent})=>{
    const preset=created++===0?'eng':'task-engine-review'
    await ctx.agentPresets.select(agent,preset)
    await agent.ctx.systemPrompt.assemble({scope:agent})
    const tools=()=>agent.ctx.tools.schemas(agent).map(t=>t.name)
    const invoke=(name,args)=>agent.ctx.tools.execute({name,arguments:args,agent,signal:new AbortController().signal,callId:`probe-${name}`})
    if(preset==='eng'){
      assert.ok(tools().includes('dev_task'))
      assert.ok(!tools().includes('read'),'repository work must select a contract first')
      const result=await invoke('dev_task',{operation:'create',task_id:'PRESET-PROBE',title:'Read-only preset fixture',intent:'analysis',intent_reason:'Keyless composition check'})
      assert.equal(result.isError,false,JSON.stringify(result))
      await agent.ctx.systemPrompt.assemble({scope:agent})
      for(const name of ['dev_task','read','glob','grep'])assert.ok(tools().includes(name),name)
      const accepted=await invoke('dev_task',{operation:'submit_analysis',task_id:'PRESET-PROBE',conclusion:'Fixture source is readable',proposal:'No implementation required',limitations:[],source_evidence:[{file:'proof.txt',start_line:1,end_line:1,quote:'Native'}]})
      assert.equal(accepted.isError,false,JSON.stringify(accepted))
      const state=JSON.parse(readFileSync(join(agent.session.header.cwd,'.dsh/task-PRESET-PROBE.json'),'utf8'))
      const snapshot=state.delivery.result.evidence[0]
      assert.equal(snapshot.quote,'Native preset composition fixture')
      assert.equal(snapshot.highlight,'Native')
      assert.equal(snapshot.range_hash,createHash('sha256').update(snapshot.quote).digest('hex'))
      assert.ok(state.completed)
    }else for(const name of ['read','glob','grep'])assert.ok(tools().includes(name),name)
    for(const name of ['write','edit','pwsh','bash','subagent','subagent_fork','workflow'])assert.ok(!tools().includes(name),`${preset}: ${name}`)
    const denied=await invoke('write',{file_path:'forbidden.txt',content:'must not be written'})
    assert.equal(denied.isError,true)
    const read=await invoke('read',{file_path:'proof.txt'})
    assert.equal(read.isError,false,JSON.stringify(read))
    observations.push({preset,tools:tools(),read_succeeded:true,write_denied:true})
    assert.equal(modelCalls,0)
    writeFileSync(process.env.TASK_ENGINE_PRESET_PROBE_RESULT,JSON.stringify({model_calls:modelCalls,observations},null,2))
  })
}
