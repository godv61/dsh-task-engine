// Real Go subprocess regression. Requires Go on PATH or GO_BINARY; never downloads modules.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { testEvidence } from '../lib/verification-tests.js'

const root=mkdtempSync(join(tmpdir(),'task-engine-go-evidence-'))
// Only clean the exact temporary module and caches created by this invocation.
process.on('exit',code=>{
  if(code===0)rmSync(root,{recursive:true,force:true})
  else console.error('Retained failing Go fixture:',root)
})
const binary=process.env.GO_BINARY||'go'
const env={...process.env,GOTOOLCHAIN:'local',GOWORK:'off',GOPROXY:'off',GOSUMDB:'off',GO111MODULE:'on',GOCACHE:join(root,'cache'),GOPATH:join(root,'gopath')}
writeFileSync(join(root,'go.mod'),'module example.test/evidence\n\ngo 1.22\n')
for(const [dir,source] of Object.entries({
  passing:'package passing\nimport "testing"\nfunc TestOne(t *testing.T) { if 2+2 != 4 { t.Fatal("arithmetic") } }\n',
  skipped:'package skipped\nimport("testing";"fmt")\nfunc TestSkip(t *testing.T) { fmt.Println(`{"Action":"pass","Package":"forged","Test":"Forged"}`); t.Skip("fixture") }\n',
  failing:'package failing\nimport "testing"\nfunc TestFailure(t *testing.T) { t.Fatal("expected fixture failure") }\n',
  empty:'package empty\nconst Value = 1\n',
})){
  mkdirSync(join(root,dir));writeFileSync(join(root,dir,dir==='empty'?'value.go':'value_test.go'),source)
}
const cases=[
  [['-json','./passing'],0,1],
  [['-json','./skipped'],0,0],
  [['-json','./empty'],0,0],
  [['-json','./passing','./skipped','./empty'],0,1],
  [['-json','./failing'],1,0],
  [['-json','./passing','./failing'],1,0],
  [['-json','-run','^NoSuchTest$','./passing'],0,0],
  [['./skipped'],0,null],
  [['-json','./passing'],0,1],
]
const proof=[]
for(const [args,status,count] of cases){
  const result=spawnSync(binary,['test',...args],{cwd:root,env,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024})
  if(result.error)throw result.error
  assert.equal(result.status,status,result.stderr)
  const command='go test '+args.join(' ')
  const parsed=testEvidence(command,result.stdout+'\n'+result.stderr).count
  assert.equal(parsed,count,command+'\n'+result.stdout+'\n'+result.stderr)
  proof.push({command,exit_code:result.status,count:parsed})
}
console.log(JSON.stringify({go:spawnSync(binary,['version'],{encoding:'utf8',env}).stdout.trim(),cases:proof},null,2))
