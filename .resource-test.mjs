import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import { prepareImport, commitImport } from './lib/resource-import.js'

const file = (path, text) => ({path,base64:Buffer.from(text).toString('base64')})
const skill = '---\nname: sample-skill\ndescription: A test skill\n---\n# Sample\n'
const baseRequest = () => ({kind:'skill',level:'project',path:'unused',files:[file('sample/SKILL.md',skill),file('sample/assets/data.bin',Buffer.from([0,128,255]))]})
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'task-engine-import-'))
  t.after(()=> { const full=resolve(root); assert.ok(full.startsWith(resolve(tmpdir())+sep)); rmSync(full,{recursive:true,force:true}) })
  return {root,base:join(root,'skills')}
}
test('preview has no filesystem side effects and reports exact bytes',t=>{
 const {base}=fixture(t),r=baseRequest(),p=prepareImport(r,base,()=>false).preview
 assert.equal(p.name,'sample-skill');assert.equal(p.files,2);assert.equal(p.bytes,Buffer.byteLength(skill)+3);assert.equal(existsSync(base),false)
})
test('confirmed install preserves binary assets and refuses duplicates',t=>{
 const {base}=fixture(t),r=baseRequest(),p=prepareImport(r,base,()=>false).preview
 commitImport({...r,expectedHash:p.hash},base,()=>false)
 assert.deepEqual(readFileSync(join(base,'sample-skill/assets/data.bin')),Buffer.from([0,128,255]))
 assert.throws(()=>commitImport({...r,expectedHash:p.hash},base,()=>false),/同名/)
})
test('changed content and changed installation target invalidate preview',t=>{
 const {root,base}=fixture(t),r=baseRequest(),p=prepareImport(r,base,()=>false).preview
 assert.throws(()=>commitImport({...r,files:[file('SKILL.md',skill+'changed')],expectedHash:p.hash},base,()=>false),/发生变化/)
 assert.throws(()=>commitImport({...r,expectedHash:p.hash},join(root,'other'),()=>false),/发生变化/)
 assert.equal(existsSync(base),false)
})
test('path traversal, Windows ADS and reserved names are rejected',t=>{
 const {base}=fixture(t)
 for(const path of ['../escape','/escape','C:/escape','x\\escape','NUL.txt','x:stream','x/../escape','x.']) {
 assert.throws(()=>prepareImport({...baseRequest(),files:[file('SKILL.md',skill),file(path,'bad')]},base,()=>false),/不安全/)
 }
})
test('case-colliding filenames are rejected',t=>{
 const {base}=fixture(t)
 assert.throws(()=>prepareImport({...baseRequest(),files:[file('SKILL.md',skill),file('a.txt','a'),file('A.txt','b')]},base,()=>false),/大小写/)
})
test('bundled names and ambiguous containers are rejected',t=>{
 const {base}=fixture(t)
 assert.throws(()=>prepareImport(baseRequest(),base,()=>true),/内置/)
 assert.throws(()=>prepareImport({...baseRequest(),files:[file('a/SKILL.md',skill),file('b/SKILL.md',skill)]},base,()=>false),/多个技能/)
})
test('single-file rule accepts UTF-8 BOM and CRLF; empty rules are refused',t=>{
 const {base}=fixture(t),r={kind:'rule',level:'project',path:'unused',files:[file('sample-rule.md','\uFEFF# Rule\r\nDo it.')]}
 const p=prepareImport(r,base,()=>false).preview
 assert.equal(p.name,'sample-rule');assert.match(p.content,/# Rule/)
 commitImport({...r,expectedHash:p.hash},base,()=>false)
 assert.ok(existsSync(join(base,'sample-rule.md')))
 assert.throws(()=>prepareImport({...r,files:[file('empty.md','  ')]},base,()=>false),/不能为空/)
})
test('file and directory prefix conflicts fail during preview',t=>{
 const {base}=fixture(t),r={...baseRequest(),files:[file('SKILL.md',skill),file('a','file'),file('a/b','child')]}
 assert.throws(()=>prepareImport(r,base,()=>false),/路径冲突/)
 assert.equal(existsSync(base),false)
})
test('failed installation removes only its own incomplete directory',t=>{
 const {base}=fixture(t),r=baseRequest(),p=prepareImport(r,base,()=>false).preview
 mkdirSync(base);writeFileSync(join(base,'keep.txt'),'existing')
 const original=fs.writeFileSync
 try {
   fs.writeFileSync=(path,...args)=>{if(String(path).endsWith('data.bin')) throw new Error('injected disk failure');return original(path,...args)}
   syncBuiltinESMExports()
   assert.throws(()=>commitImport({...r,expectedHash:p.hash},base,()=>false),/injected disk failure/)
 } finally { fs.writeFileSync=original;syncBuiltinESMExports() }
 assert.equal(existsSync(p.target),false);assert.deepEqual(readdirSync(base),['keep.txt']);assert.equal(readFileSync(join(base,'keep.txt'),'utf8'),'existing')
})

test('host directory scanner resolves one container child and excludes caches',t=>{
 const {root,base}=fixture(t),src=join(root,'source'),nested=join(src,'sample')
 mkdirSync(join(nested,'node_modules'),{recursive:true});writeFileSync(join(nested,'SKILL.md'),skill);writeFileSync(join(nested,'node_modules','ignore.txt'),'ignore')
 const p=prepareImport({...baseRequest(),files:[],sourceDir:src},base,()=>false).preview
 assert.equal(p.files,1)
})
test('host scanner rejects symlink or junction source paths',t=>{
 const {root,base}=fixture(t),src=join(root,'source'),link=join(root,'link')
 mkdirSync(src);writeFileSync(join(src,'SKILL.md'),skill)
 symlinkSync(src,link,process.platform==='win32'?'junction':'dir')
 assert.throws(()=>prepareImport({...baseRequest(),files:[],sourceDir:link},base,()=>false),/符号链接/)
})
test('deep directories and oversized files fail before installation',t=>{
 const {base}=fixture(t)
 assert.throws(()=>prepareImport({...baseRequest(),files:[file('SKILL.md',skill),file('a/'.repeat(21)+'b','x')]},base,()=>false),/20 层/)
 assert.throws(()=>prepareImport({...baseRequest(),files:[file('SKILL.md',skill),file('big',Buffer.alloc(20*1024*1024+1))]},base,()=>false),/大小限制|20 MB/)
 assert.equal(existsSync(base),false)
})
test('invalid UTF-8, encoding and absent source directories report errors',t=>{
 const {root,base}=fixture(t)
 assert.throws(()=>prepareImport({...baseRequest(),files:[{path:'SKILL.md',base64:'not base64!!'}]},base,()=>false),/编码/)
 assert.throws(()=>prepareImport({kind:'rule',level:'user',path:'unused',files:[file('rule.md',Buffer.from([255]))]},base,()=>false))
 assert.throws(()=>prepareImport({...baseRequest(),files:[],sourceDir:join(root,'missing')},base,()=>false))
})

test('registered host workspace wins over client spelling; unknown paths fail', async () => {
 const {authorizedWorkspace}=await import('./lib/workspace-access.js')
 const host={get:()=>({resolveByPath:async path=>path==='known'?{path:'/canonical/project'}:undefined})}
 assert.equal(await authorizedWorkspace(host,'known',()=>{throw new Error('fallback must not run')}),'/canonical/project')
 await assert.rejects(()=>authorizedWorkspace(host,'unknown',()=>'/unsafe'),/未在 Harness 注册/)
 await assert.rejects(()=>authorizedWorkspace(host,'',()=>'/unsafe'),/请选择/)
})
test('legacy host retains its explicit workspace policy', async () => {
 const {authorizedWorkspace}=await import('./lib/workspace-access.js')
 assert.equal(await authorizedWorkspace({get:()=>undefined},'/project',p=>p),'/project')
 await assert.rejects(()=>authorizedWorkspace({get:()=>undefined},'/bad',()=>{throw new Error('denied')}),/denied/)
})
test('host registry failures are not downgraded to legacy permissions', async () => {
 const {authorizedWorkspace}=await import('./lib/workspace-access.js')
 await assert.rejects(()=>authorizedWorkspace({get:()=>({resolveByPath:async()=>{throw new Error('registry unavailable')}})},'/project',()=>'/unsafe'),/registry unavailable/)
})

test('ledger shows absent storage as empty and propagates access errors',async()=>{
 const {default:Controller}=await import('./lib/controller.js')
 const controller=Object.create(Controller.prototype)
 controller.authorizedPath=async p=>p
 controller.fs=()=>({resolve:async p=>p,listDir:async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'})}})
 assert.deepEqual(await controller.readTasks('/project'),{tasks:[]})
 controller.fs=()=>({resolve:async p=>p,listDir:async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'})}})
 await assert.rejects(()=>controller.readTasks('/project'),/denied/)
})
test('ledger rejects malformed records instead of pretending there are no tasks',async()=>{
 const {default:Controller}=await import('./lib/controller.js')
 const controller=Object.create(Controller.prototype)
 controller.authorizedPath=async p=>p
 for(const content of ['{broken','null','{}']) {
   controller.fs=()=>({resolve:async p=>p,listDir:async()=>[{name:'task-broken.json'}],readText:async()=>content})
   await assert.rejects(()=>controller.readTasks('/project'),/任务记录/)
 }
})
test('ledger exposes Sonar findings without project credentials',async()=>{
 const {default:Controller}=await import('./lib/controller.js')
 const controller=Object.create(Controller.prototype)
 controller.authorizedPath=async p=>p
 controller.fs=()=>({resolve:async p=>p,listDir:async()=>[{name:'task-sample.json'}],readText:async()=>JSON.stringify({
   id:'sample',title:'Sample',stage:'代码审核',branch:'feature/sample',items:[],
   sonar_policy:{source:'ide-local',token_env:'SONAR_TOKEN',host_url:'https://sonar.example',project_key:'sample'},
   sonar_audit:{gate:'ERROR',checked_at:'2026-10-03T00:00:00Z',target:'main',
     findings:[{key:'issue-1',rule:'java:S103',message:'Line too long',severity:'MAJOR',file:'Sample.java',line:3}],
     blocking:[{key:'issue-1'}],uncovered_files:[]},
 })})
 const {tasks}=await controller.readTasks('/project')
 assert.equal(tasks[0].sonar.audit.gate,'ERROR')
 assert.equal(tasks[0].sonar.audit.blocking_count,1)
 assert.deepEqual(tasks[0].sonar.audit.findings[0],{key:'issue-1',rule:'java:S103',message:'Line too long',severity:'MAJOR',file:'Sample.java',line:3})
 assert.equal(JSON.stringify(tasks).includes('SONAR_TOKEN'),false)
})

test('project resource remotes reject a missing workspace before touching files', async () => {
 const {default:Controller}=await import('./lib/controller.js')
 const receiver={authorizedPath:async()=>{throw new Error('must not resolve an absent workspace')}}
 for (const [method, request] of [
   ['writeSkill',{level:'project',name:'sample',description:'sample',content:'body'}],
   ['writeRule',{level:'project',name:'sample',content:'body'}],
   ['readSkill',{level:'project',name:'sample'}],
   ['readRule',{level:'project',name:'sample'}],
   ['deleteSkill',{level:'project',name:'sample'}],
   ['deleteRule',{level:'project',name:'sample'}],
   ['installSkill',{level:'project',name:'sample',sourceDir:'/tmp/sample'}],
 ]) await assert.rejects(()=>Controller.prototype[method].call(receiver,request),/必须指定已注册工作区/)
})

test('directory picker rejects an unregistered location outside the user home', async () => {
 const {default:Controller}=await import('./lib/controller.js')
 const receiver={authorizedPath:async()=>{throw new Error('unregistered')}}
 const view=await Controller.prototype.listDirs.call(receiver,{path:parse(homedir()).root})
 assert.equal(view.ok,false)
 assert.match(view.error,/只能浏览用户主目录或已注册的工作区/)
})
