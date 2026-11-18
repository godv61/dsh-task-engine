// Real DSH tool registry + Office tool; the conversion backend is a controlled fixture.
// This verifies activation, access guards, input authority and temp-file readback, not Office layout/conversion fidelity.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolOffice from '@deepseek-ai/dsh-tool-office'
import { OfficeKitError } from '@deepseek-ai/dsh-office-kit'
import { createScope } from '@deepseek-ai/dsh-scope'
import { executeTool, installTestExecutor } from './scripts/fixtures/tool-runtime.mjs'
import { bindDeliveryIntent, installDeliveryAccess, analysisAccessProblem } from './lib/delivery-access.js'

const text = '需求范围：审批与退回。\n表格字段：角色、部门、状态。\n'
const hash = data => createHash('sha256').update(data).digest('hex')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
function docx() {
  // Minimal, genuine OOXML ZIP, stored without compression to keep this fixture self-contained.
  const files = [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>需求范围：审批与退回。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>角色、部门、状态。</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>'],
  ]
  const records=[], directory=[]; let offset=0
  for (const [name,value] of files) {
    const n=Buffer.from(name), data=Buffer.from(value), crc=crc32(data)
    const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26)
    records.push(local,n,data)
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42)
    directory.push(central,n);offset+=local.length+n.length+data.length
  }
  const end=Buffer.alloc(22), dirs=Buffer.concat(directory)
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(dirs.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...records,dirs,end])
}
async function fixture(t, mode='analysis', options={}) {
  const temp = mkdtempSync(join(tmpdir(),'task-office-'))
  const cwd=join(temp,'workspace'), output=join(temp,'host-office-output');mkdirSync(cwd);mkdirSync(output)
  const source=join(cwd,'需求 V5.docx');writeFileSync(source,docx())
  const before=hash(readFileSync(source)), root=new Context()
  t.after(async()=>{ await root.fiber.dispose();assert.equal(dirname(realpathSync(temp)),realpathSync(tmpdir()));assert.ok(basename(temp).startsWith('task-office-'));rmSync(temp,{recursive:true,force:true}) })
  await root.plugin(SystemPrompt);await root.plugin(ToolRuntime);await installTestExecutor(root);await root.plugin(SkillRegistry)
  root.provide('workingDirectory',{ensure:async()=>cwd});root.provide('agents',{get:()=>undefined})
  let allowed=true, converted=0, rendered=0, commands=0, mutations=0
  const inputAccess=path=>{if(!allowed&&path===source)throw Error('fixture source read denied')}
  root.provide('fs',{
    resolve:async p=>({path:resolve(cwd,p),displayPath:resolve(cwd,p)}),
    stat:async target=>({type:'file',version:hash(readFileSync(target.path)),size:readFileSync(target.path).length}),
    readByteRange:async target=>{inputAccess(target.path);return readFileSync(target.path).subarray(0,1)},
    readBytes:async target=>{inputAccess(target.path);return readFileSync(target.path)},
    processPath:target=>target.path,processPathFromHostPath:path=>path,
  })
  root.provide('llm',{resolveModelInfo:async()=>({provider:'fixture',id:'vision',inputModalities:['text','image']})})
  root.provide('attachments',{
    imageLimits:{maxImagesPerMessage:10,maxImagePixels:100,maxImageDimension:100,maxMessageImageBytes:10000,maxImageBytes:10000},
    saveImages:async images=>images.map((im,i)=>({attachmentId:'image-'+i,mediaType:'image/png',bytes:im.data.length,width:1,height:1})),
    isAttachmentError:()=>false,
  })
  if (!options.missingKit) root.provide('officeKit',{
    outputDirectory:output,
    convertTo:async request=>{converted++;if(options.unavailable)throw new OfficeKitError('unavailable','fixture converter offline');const bytes=(await request.source.read(new AbortController().signal,100000)).bytes;assert.equal(hash(bytes),before);const path=join(output,request.output.name);writeFileSync(path,text);return{path,bytes:Buffer.byteLength(text),missingFonts:[]}},
    renderImages:async request=>{rendered++;await request.source.read(new AbortController().signal,100000);return{images:[{png,width:1,height:1,page:1}],pageCount:1,dpi:144,missingFonts:[]}},
    recalculate:async()=>{mutations++;throw Error('recalculate must not execute')},
  })
  await root.plugin(ToolOffice)
  const register=(name,parameters,execute)=>root.tools.register(defineTool({name,description:name,parameters,output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute}))
  root.skills.register({name:'office',source:'runtime',description:'Office fixture',content:'Use Office tools.'})
  register('skill',{name:{type:'string',required:true}},async args=>(await root.skills.get(args.name)).content)
  register('read',{path:{type:'string',required:true}},async args=>{const path=resolve(cwd,args.path);inputAccess(path);return readFileSync(path,'utf8')})
  for(const name of ['pwsh','write','edit'])register(name,{},async()=>{if(name==='pwsh')commands++;else mutations++;return'bad'})
  let owner;await root.plugin({name:'fixture-owner',inject:['tools','fs'],apply(ctx){owner=ctx}})
  const agent={id:'doc-parent',options:{provider:'fixture',model:'vision'},session:{id:'doc-parent',header:{cwd},requestHeader:()=>undefined}}
  const scope=createScope(owner,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
  installDeliveryAccess(scope.ctx,async()=>undefined);bindDeliveryIntent(agent,mode)
  let call=0
  const invoke=async(name,args={})=>{
    const signal=new AbortController().signal
    const toolSet=await root.tools.resolve({agent,modelSelection:{provider:'fixture',model:'vision'},signal})
    try{return await executeTool(root,{name,arguments:args,agent,signal,callId:'office-'+(++call),toolSet})}finally{toolSet.dispose()}
  }
  return{root,agent,scope,cwd,source,output,before,invoke,activate:()=>invoke('skill',{name:'office'}),
    get counts(){return{converted,rendered,commands,mutations}},denySource(){allowed=false},
    unchanged(){assert.equal(hash(readFileSync(source)),before);assert.deepEqual(readdirSync(cwd),['需求 V5.docx'])}}
}
const content=r=>(r.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')

for(const mode of ['analysis','requirements','history'])test(`${mode}: Office activates after the guard, extracts text and reads host temp output without workspace writes`,async t=>{
  const f=await fixture(t,mode)
  assert.equal((await f.invoke('office_convert',{input:f.source,format:'txt'})).isError,true)
  assert.equal((await f.activate()).isError,false)
  const result=await f.invoke('office_convert',{input:f.source,format:'txt'})
  assert.equal(result.isError,false,content(result))
  const read=await f.invoke('read',{path:join(f.output,'需求 V5.txt')})
  assert.equal(read.isError,false);assert.equal(content(read),text)
  assert.deepEqual(f.counts,{converted:1,rendered:0,commands:0,mutations:0});f.unchanged()
  const prompt=await f.root.systemPrompt.assemble({scope:f.agent})
  assert.ok(prompt.sections.some(s=>s.name==='task-engine:document-reading'&&s.text.includes('不要按转换工具的通用交付提示执行 shell')))
})

test('read-only Office previews work while non-text exports, recalculation and native mutations stay blocked',async t=>{
  const f=await fixture(t);await f.activate()
  const preview=await f.invoke('office_render',{input:f.source,pages:[1]})
  assert.equal(preview.isError,false,content(preview))
  for(const args of [{input:f.source,format:'pdf'},{input:f.source,format:'docx'},{input:'book.xlsx',format:'txt'},{input:f.source,format:'txt',output:'app.js'},{input:f.source,format:'txt',sheet:'Sheet1'}]) {
    const result=await f.invoke('office_convert',args);assert.equal(result.isError,true);assert.match(content(result),/只读阶段 office_convert/)
  }
  for(const name of ['pwsh','write','edit','office_recalculate'])assert.equal((await f.invoke(name,name==='office_recalculate'?{input:'book.xlsx',format:'xlsx'}:{})).isError,true)
  assert.deepEqual(f.counts,{converted:0,rendered:1,commands:0,mutations:0});f.unchanged()
})

test('source permissions and converter outages are preserved as errors, not successful reads',async t=>{
  const denied=await fixture(t);await denied.activate();denied.denySource()
  const r=await denied.invoke('office_convert',{input:denied.source,format:'txt'})
  assert.equal(r.isError,true);assert.match(content(r),/source read denied/);assert.equal(denied.counts.converted,0)
  const offline=await fixture(t,'analysis',{unavailable:true});await offline.activate()
  const failure=await offline.invoke('office_convert',{input:offline.source,format:'txt'})
  assert.equal(failure.isError,true);assert.match(content(failure),/fixture converter offline/);offline.unchanged()
  const absent=await fixture(t,'analysis',{missingKit:true});await absent.activate()
  const missing=await absent.invoke('office_convert',{input:absent.source,format:'txt'})
  assert.equal(missing.isError,true);assert.match(content(missing),/converter is unavailable/);assert.equal(absent.counts.converted,0)
})

test('pending mode still requires task selection and implementation restores the broader Office surface',async t=>{
  const f=await fixture(t,'pending');await f.activate()
  assert.equal((await f.invoke('office_convert',{input:f.source,format:'txt'})).isError,true);assert.equal(f.counts.converted,0)
  bindDeliveryIntent(f.agent,'requirements')
  assert.ok(analysisAccessProblem(f.agent,'office_convert',{input:f.source,format:'pdf'}))
  bindDeliveryIntent(f.agent,'implementation')
  assert.equal(analysisAccessProblem(f.agent,'office_convert',{input:f.source,format:'pdf'}),undefined)
  assert.ok(f.root.tools.schemas(f.agent).some(t=>t.name==='pwsh'))
  assert.equal((await f.invoke('office_convert',{input:f.source,format:'pdf'})).isError,false)
  bindDeliveryIntent(f.agent,undefined)
  const prompt=await f.root.systemPrompt.assemble({scope:f.agent})
  assert.ok(!prompt.sections.some(s=>s.name==='task-engine:document-reading'&&s.text.trim()))
})

test('scope-local Office calls cannot bypass read-only argument validation',async t=>{
  const f=await fixture(t,'requirements');let calls=0
  f.scope.ctx.tools.register(defineTool({name:'office_convert',description:'Scoped conversion',parameters:{input:{type:'string',required:true},format:{type:'string',required:true}},
    output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{calls++;return'scoped output'}}))
  assert.ok(f.root.tools.schemas(f.agent).some(t=>t.name==='office_convert'))
  const denied=await f.invoke('office_convert',{input:f.source,format:'pdf'})
  assert.equal(denied.isError,true);assert.match(content(denied),/只读阶段 office_convert/);assert.equal(calls,0)
})
