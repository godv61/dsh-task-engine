// Loaded only by verify-host-preset; no credentials and no model requests.
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name='task-engine-keyless-preset-probe'
export const inject=['llm','agentPresets','tools','systemPrompt']
export function apply(ctx){
  let modelCalls=0,created=0,requirementQuestions=0
  const observations=[]
  class OfflineAdapter extends LlmAdapter{
    async *generate(){modelCalls++;throw new Error('Keyless preset test must not call a model')}
  }
  ctx.llm.registerAdapter(['preset-fixture'],new OfflineAdapter())
  ctx.on('user-questions/request',async(request,next)=>{
    if(!request.questions.every(q=>q.header==='确认需求范围'))return next()
    requirementQuestions++
    assert.match(request.questions[0].detail,/需求总结/)
    return {answers:request.questions.map(q=>({id:q.id,selected:['确认无误，继续']}))}
  })
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
      const requirementTask='PRESET-REQUIREMENT'
      const omitted=await invoke('dev_task',{operation:'create',task_id:'MISSING-INTENT',title:'missing intent',branch:'fixture',complexity:'low',complexity_reason:'fixture'})
      assert.equal(omitted.isError,true)
      const missingGrade=await invoke('dev_task',{operation:'create',task_id:'MISSING-GRADE',title:'missing grade',intent:'implementation',intent_reason:'fixture'})
      assert.equal(missingGrade.isError,true)
      const metaPath=join(agent.session.header.cwd,'.dsh/meta.json')
      writeFileSync(metaPath,JSON.stringify({requirement_confirmation:'legacy'}))
      const disabled=await invoke('dev_task',{operation:'create',task_id:'DISABLED-REQUIREMENT',title:'removed opt-out',intent:'implementation',intent_reason:'fixture',complexity:'low',complexity_reason:'fixture'})
      assert.equal(disabled.isError,true)
      unlinkSync(metaPath)
      const call=async args=>{
        const output=await invoke('dev_task',{task_id:requirementTask,...args})
        assert.equal(output.isError,false,JSON.stringify(output))
        return output.content.filter(p=>p.type==='text').map(p=>p.text).join('\n')
      }
      await call({operation:'create',title:'Requirement confirmation fixture',intent:'implementation',intent_reason:'Keyless confirmation check',complexity:'low',complexity_reason:'One fixture file'})
      assert.equal((await invoke('write',{file_path:'forbidden.txt',content:'before human confirmation'})).isError,true)
      await call({operation:'record',artifact:'requirement',fields:{goal:'write fixture',scope:'one file',acceptance:'fixture exists'}})
      const summary=JSON.parse(await call({operation:'prepare_requirement'}))
      await call({operation:'confirm_requirement',expected_hash:summary.requirement.hash})
      const questionCount=requirementQuestions
      await call({operation:'confirm_requirement',expected_hash:summary.requirement.hash})
      assert.equal(requirementQuestions,questionCount)
      const approved=JSON.parse(readFileSync(join(agent.session.header.cwd,`.dsh/task-${requirementTask}.json`),'utf8'))
      assert.equal(approved.requirements.document.confirmation.hash,summary.requirement.hash)
      assert.equal((await invoke('write',{file_path:'approved-fixture.txt',content:'after human confirmation'})).isError,false)
      // An external edit must revoke native writes before a later dev_task call.
      writeFileSync(join(agent.session.header.cwd,summary.requirement.path),'changed requirement')
      assert.equal((await invoke('write',{file_path:'forbidden.txt',content:'stale confirmation'})).isError,true)
      writeFileSync(join(agent.session.header.cwd,summary.requirement.path),summary.content)
      await agent.ctx.systemPrompt.assemble({scope:agent})
      assert.ok(tools().includes('write'),'restored approval must restore the model tool catalog')
      assert.equal((await invoke('write',{file_path:'restored-fixture.txt',content:'restored exact approval'})).isError,false)
      assert.equal(requirementQuestions,questionCount)
      writeFileSync(join(agent.session.header.cwd,summary.requirement.path),'changed again')
      assert.equal((await invoke('write',{file_path:'forbidden.txt',content:'must still be denied'})).isError,true)
      const taskPath=join(agent.session.header.cwd,`.dsh/task-${requirementTask}.json`)
      delete approved.flow.config.requirement_review
      approved.flow.hash=createHash('sha256').update(JSON.stringify(approved.flow.config)).digest('hex')
      const oldRecord=JSON.stringify(approved);writeFileSync(taskPath,oldRecord)
      const oldStatus=JSON.parse(await call({operation:'status'}))
      assert.match(oldStatus.execution_blocker,/仅可查看.*重新创建/)
      assert.equal((await invoke('dev_task',{operation:'verify',task_id:requirementTask,command:'npm test'})).isError,true)
      assert.equal((await invoke('write',{file_path:'forbidden.txt',content:'old task must not unlock writes'})).isError,true)
      assert.equal(readFileSync(taskPath,'utf8'),oldRecord)
      approved.completed={at:'2026-10-30T00:00:00Z'};writeFileSync(taskPath,JSON.stringify(approved))
      await call({operation:'status'})
      assert.equal((await invoke('write',{file_path:'forbidden.txt',content:'history must remain read-only'})).isError,true)
      const fresh=await invoke('dev_task',{operation:'create',task_id:'CURRENT-AFTER-HISTORY',title:'current task',intent:'implementation',intent_reason:'fixture',complexity:'low',complexity_reason:'fixture'})
      assert.equal(fresh.isError,false,JSON.stringify(fresh))
    }else for(const name of ['read','glob','grep'])assert.ok(tools().includes(name),name)
    for(const name of ['write','edit','pwsh','bash','subagent','subagent_fork','workflow'])assert.ok(!tools().includes(name),`${preset}: ${name}`)
    const denied=await invoke('write',{file_path:'forbidden.txt',content:'must not be written'})
    assert.equal(denied.isError,true)
    const read=await invoke('read',{file_path:'proof.txt'})
    assert.equal(read.isError,false,JSON.stringify(read))
    observations.push({preset,tools:tools(),read_succeeded:true,write_denied:true,
      ...(preset==='eng'?{requirement_questions:requirementQuestions,removed_opt_out_rejected:true,old_task_readonly:true,history_readonly:true,new_task_after_history:true}: {})})
    assert.equal(modelCalls,0)
    writeFileSync(process.env.TASK_ENGINE_PRESET_PROBE_RESULT,JSON.stringify({model_calls:modelCalls,observations},null,2))
  })
}
