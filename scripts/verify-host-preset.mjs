/** Boot a declared supported host and this packed plugin through its public SDK profile, keylessly. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, readdirSync, cpSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'))
const hostVersion=process.env.TASK_ENGINE_DSH_VERSION??manifest.devDependencies['@deepseek-ai/dsh-typert-protocol']
const supported=manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'].split('||').map(version=>version.trim())
assert.ok(supported.includes(hostVersion)||hostVersion===manifest.devDependencies['@deepseek-ai/dsh-typert-protocol'],`DSH ${hostVersion} is neither supported nor the pinned development candidate`)

// Windows runners may expose TEMP through an 8.3 alias. Use one real path for
// SDK file URLs and the child loader so scope registries share module identity.
const root=mkdtempSync(join(realpathSync.native(tmpdir()),'task-engine-preset-host-'))
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
  // A cold Windows SDK dependency tree exceeded five minutes on the hosted
  // runner. This setup budget does not extend the SDK or tool request timeouts.
  const timeout=args[0]==='install'&&process.platform==='win32'?600000:300000
  console.log(`Preparing preset fixture: npm ${args[0]} (timeout ${timeout/1000}s)`)
  const result=spawnSync(process.execPath,[process.env.npm_execpath,...args],{cwd,env,encoding:'utf8',timeout,maxBuffer:8*1024*1024})
  if(result.error)throw new Error(`Preset fixture npm ${args[0]} failed: ${result.error.message}\n${String(result.stderr??'').slice(-4000)}`,{cause:result.error})
  if(result.status!==0)throw new Error(result.stderr||result.stdout)
  return result.stdout
}
const packed=command(['pack','--json','--pack-destination',root],resolve(import.meta.dirname,'..'))
const jsonStart=packed.indexOf('[\n')>=0?packed.indexOf('[\n'):packed.indexOf('[\r\n')
assert.ok(jsonStart>=0,'npm pack must return a JSON manifest')
const artifact=JSON.parse(packed.slice(jsonStart))[0]
writeFileSync(join(root,'package.json'),JSON.stringify({name:'keyless-preset-host',private:true,type:'module'}))
const cachedModules=process.env.TASK_ENGINE_PRESET_NODE_MODULES
if(cachedModules){
  // Reuse installed public dependencies only. The packed plugin, workspace and
  // DSH_HOME remain fresh, and this code never edits the caller's module tree.
  const cache=resolve(cachedModules),local=join(root,'node_modules')
  for(const name of ['dsh','dsh-sdk-client','dsh-agent-preset-registry','dsh-tool-subagent'])
    assert.equal(JSON.parse(readFileSync(join(cache,'@deepseek-ai',name,'package.json'),'utf8')).version,hostVersion,`cached ${name} must match DSH ${hostVersion}`)
  mkdirSync(local)
  for(const entry of readdirSync(cache,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('.')&&e.name!=='@godv61'))
    // Host-base module resolution follows real paths. Junctions could silently
    // load a different task-engine from the cache instead of this packed copy.
    cpSync(join(cache,entry.name),join(local,entry.name),{recursive:true,dereference:true})
  assert.ok(artifact.files.every(file=>!file.path.startsWith('/')&&!file.path.split('/').includes('..')))
  const plugin=join(local,'@godv61','dsh-task-engine');mkdirSync(plugin,{recursive:true})
  const unpack=spawnSync('tar',['-xzf',join(root,artifact.filename),'--strip-components=1','-C',plugin],{encoding:'utf8'})
  if(unpack.error)throw unpack.error
  assert.equal(unpack.status,0,unpack.stderr)
}else{
  command(['install','--ignore-scripts','--no-audit','--no-fund','--prefer-offline','--fetch-retries=0',
    ...['dsh','dsh-sdk-client','dsh-agent-preset-registry','dsh-tool-subagent'].map(name=>`@deepseek-ai/${name}@${hostVersion}`),join(root,artifact.filename)])
}
const modules=join(root,'node_modules','@deepseek-ai')
// Check our source against this exact host's public declarations as well as
// running the packed build. Dependencies in the authoring worktree stay intact.
const sourceRoot=resolve(import.meta.dirname,'..')
if(existsSync(join(sourceRoot,'src'))){
  for(const config of ['tsconfig.json','tsconfig.client.json']){
    const target=join(root,`host-${config}`)
    writeFileSync(target,JSON.stringify({extends:join(sourceRoot,config),compilerOptions:{
      baseUrl:root,paths:{'@deepseek-ai/*':[join(modules,'*')]},
      typeRoots:[join(sourceRoot,'node_modules','@types')],noEmit:true}}))
    const checked=spawnSync(process.execPath,[join(sourceRoot,'node_modules','typescript','bin','tsc'),'-p',target],
      {cwd:sourceRoot,env,encoding:'utf8',timeout:60000})
    if(checked.error)throw checked.error
    assert.equal(checked.status,0,checked.stdout+checked.stderr)
  }
}
const probe=join(root,'probe.mjs'),proof=join(root,'proof.json')
copyFileSync(new URL('./fixtures/preset-probe.mjs',import.meta.url),probe)
copyFileSync(new URL('./fixtures/tool-runtime.mjs',import.meta.url),join(root,'tool-runtime.mjs'))
const overlay=join(root,'probe.patch.yml')
// Exercise a PTC deployment ancestor on the new host; the engine presets must
// select native execution without changing the deployment or sibling Agents.
const ptc=hostVersion==='0.2.2-rc.1'
writeFileSync(overlay,`${ptc?'- id: tool-executor-native\n  disabled: true\n- id: tool-executor-ptc\n  disabled: false\n':''}- insert:
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
  patches:[overlay,join(root,'node_modules','@godv61','dsh-task-engine','cordis.patch.yml')],env:{...env,TASK_ENGINE_PRESET_PROBE_RESULT:proof,TASK_ENGINE_PRESET_PTC:String(ptc)}})
try{
  await harness.session('preset-eng-fixture').getWorkingDirectory()
  await harness.session('preset-readonly-fixture').getWorkingDirectory()
  const result=JSON.parse(readFileSync(proof,'utf8'))
  assert.equal(result.model_calls,0);assert.equal(result.observations.length,2)
  assert.ok(!existsSync(join(project,'forbidden.txt')))
  console.log(JSON.stringify({host:hostVersion,...result},null,2))
}finally{await harness.close()}
