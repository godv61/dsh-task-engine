/** Boot the published rc.3 host and this packed plugin through its public SDK profile, keylessly. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root=mkdtempSync(join(tmpdir(),'task-engine-preset-host-'))
// This exact directory was created by this invocation; never remove a caller-supplied path.
process.on('exit',code=>{
  if(code===0)rmSync(root,{recursive:true,force:true})
  else console.error('Retained failing preset fixture:',root)
})
const project=join(root,'project'),home=join(root,'home')
mkdirSync(project);mkdirSync(home)
writeFileSync(join(project,'proof.txt'),'Native preset composition fixture\n')
writeFileSync(join(project,'package.json'),JSON.stringify({name:'preset-proof-project',private:true}))
const env={...process.env,DSH_HOME:home,NO_UPDATE_NOTIFIER:'1',npm_config_update_notifier:'false'}
env.npm_config_registry='https://registry.npmjs.org/'
for(const key of Object.keys(env))if(/(?:TOKEN|API_KEY|SECRET|PASSWORD|AUTHORIZATION)/iu.test(key))delete env[key]
function command(args,cwd=root){
  assert.ok(process.env.npm_execpath,'Run through npm run verify:preset so npm is invoked without a shell')
  const result=spawnSync(process.execPath,[process.env.npm_execpath,...args],{cwd,env,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024})
  if(result.error)throw result.error
  if(result.status!==0)throw new Error(result.stderr||result.stdout)
  return result.stdout
}
const packed=command(['pack','--json','--pack-destination',root],resolve(import.meta.dirname,'..'))
const jsonStart=packed.indexOf('[\n')>=0?packed.indexOf('[\n'):packed.indexOf('[\r\n')
assert.ok(jsonStart>=0,'npm pack must return a JSON manifest')
const artifact=JSON.parse(packed.slice(jsonStart))[0]
writeFileSync(join(root,'package.json'),JSON.stringify({name:'keyless-preset-host',private:true,type:'module'}))
command(['install','--ignore-scripts','--no-audit','--no-fund',
  '@deepseek-ai/dsh@0.2.1-rc.3','@deepseek-ai/dsh-sdk-client@0.2.1-rc.3',
  '@deepseek-ai/dsh-agent-preset-registry@0.2.1-rc.3','@deepseek-ai/dsh-tool-subagent@0.2.1-rc.3',join(root,artifact.filename)])
const modules=join(root,'node_modules','@deepseek-ai')
const probe=join(root,'probe.mjs'),proof=join(root,'proof.json')
copyFileSync(new URL('./fixtures/preset-probe.mjs',import.meta.url),probe)
const overlay=join(root,'probe.patch.yml')
writeFileSync(overlay,`- insert:
    - id: preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config: { default: standard }
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: standard, plugins: [] }
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
    - id: preset-probe
      name: '${pathToFileURL(probe).href}'
`)
const {DeepSeekHarness}=await import(pathToFileURL(join(modules,'dsh-sdk-client','lib','index.js')).href)
const harness=new DeepSeekHarness({profile:'sdk',dshBin:join(modules,'dsh','lib','bin.js'),dshHome:home,
  processCwd:root,cwd:project,provider:'preset-fixture',model:'offline',initializeTimeoutMs:60000,requestTimeoutMs:60000,
  patches:[overlay,join(root,'node_modules','@godv61','dsh-task-engine','cordis.patch.yml')],env:{...env,TASK_ENGINE_PRESET_PROBE_RESULT:proof}})
try{
  await harness.session('preset-eng-fixture').getWorkingDirectory()
  await harness.session('preset-readonly-fixture').getWorkingDirectory()
  const result=JSON.parse(readFileSync(proof,'utf8'))
  assert.equal(result.model_calls,0);assert.equal(result.observations.length,2)
  assert.ok(!existsSync(join(project,'forbidden.txt')))
  console.log(JSON.stringify({host:'0.2.1-rc.3',...result},null,2))
}finally{await harness.close()}
