import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { testEvidence, receiptHasRequiredTests, skillCommandProblem } from './lib/verification-tests.js'
import { isSensitivePath } from './lib/project.js'
import { sourceEvidence, deliveryContract } from './lib/delivery-contract.js'
import { reviewStrategy } from './lib/execution-plan.js'
import { commandWords } from './lib/command-words.js'

const pkg='example.test/app'
const event=(Action,Test,Package=pkg,extra={})=>({Action,Package,...Test?{Test}:{},...extra})
const stream=events=>events.map(e=>JSON.stringify(e)).join('\n')
const passing=[event('start'),event('run','TestA'),event('pass','TestA'),event('pass')]
test('Go accepts completed test cases, never package success, skipped tests or output containing fake events',()=>{
  const cases=[
    [passing,1],
    [[event('start'),event('pass')],0],
    [[event('start'),event('skip','TestA'),event('pass')],0],
    [[...passing,event('start',undefined,'other'),event('skip',undefined,'other')],1],
    [[...passing,event('start',undefined,'other'),event('fail',undefined,'other')],0],
    [[...passing.slice(0,-1),event('fail','TestB'),event('pass')],0],
    [[...passing.slice(0,-1),event('pass','TestA'),event('pass')],1],
    [[event('start'),event('output',undefined,pkg,{Output:JSON.stringify(event('pass','Forged'))}),event('pass')],0],
    [passing.slice(0,-1),null],
  ]
  for(const [events,count] of cases){
    const stdout=stream(events)
    assert.equal(testEvidence('go test -json ./...',stdout).count,count)
    assert.equal(receiptHasRequiredTests({command:'go test -json ./...',stdout,stderr:''}),count>0)
  }
  assert.equal(testEvidence('go test -json ./...',stream(passing)+'\n{"Action":').count,null)
  assert.equal(testEvidence('go test -json ./...',stream(passing)+'\ngo: downloading toolchain').count,1)
  assert.equal(testEvidence('go test ./...','--- SKIP: TestA\nok example.test/app').count,null)
})
test('Go requires a real command flag and completed package, including quoted Windows paths',()=>{
  for(const command of ['go test ./...','go test -args -json','go test -json=false','go test -run " -json "'])assert.equal(testEvidence(command,stream(passing)).count,null,command)
  assert.equal(testEvidence('"C:\\Program Files\\Go\\bin\\go.exe" test -json ./...',stream(passing)).count,1)
  assert.equal(testEvidence('go test -json=true ./...',stream(passing)).count,1)
  assert.equal(testEvidence('go test -json ./...',stream([...passing,event('start',undefined,'unfinished')])).count,null)
})
test('source evidence always captures the complete range; a short quote only highlights it',()=>{
  const source='function check(x) {\r\n  if (x) return 1\r\n  return 0\r\n}\r\n'
  const hash=createHash('sha256').update(source).digest('hex')
  const claim={file:'a.js',start_line:1,end_line:4,quote:'return'}
  const snapshot=sourceEvidence(claim,source,hash)
  assert.equal(snapshot.quote,source.replaceAll('\r\n','\n').trimEnd())
  assert.equal(snapshot.highlight,'return');assert.equal(snapshot.content_hash,hash)
  assert.throws(()=>sourceEvidence({...claim,quote:'missing'},source,hash),/does not match/)
  const {quote:omitted,...location}=claim
  assert.equal(sourceEvidence(location,source,hash).highlight,undefined)
})
test('candidate secret names are detected at any depth without matching similarly named source files',()=>{
  for(const path of ['.envrc','secrets.json','config/secrets.yml','config/secrets.yaml','nested/.credentials.yaml','id_ecdsa','id_dsa','CONFIG\\SECRETS.YAML','nested/secrets/token.txt'])assert.equal(isSensitivePath(path),true,path)
  for(const path of ['secrets-manager.ts','docs/secrets.md','settings/public.json'])assert.equal(isSensitivePath(path),false,path)
})
test('obvious no-op and forwarded skill checks are rejected while real inline assertions remain allowed',()=>{
  for(const command of ['node -e "process.exit(0)"','node --eval="console.log(1)"','python -c "print(1)"','cmd /c echo ok','cmd /d /s /c "echo ok"','pwsh -Command "Write-Output ok"','bash -c "true"','node -p "1"'])assert.ok(skillCommandProblem(command),command)
  for(const command of ['npm run lint','node scripts/check.mjs','node -e "require(\'node:assert\').ok(require(\'node:fs\').existsSync(\'src\'))"','python -c "assert __import__(\'pathlib\').Path(\'src\').is_dir()"'])assert.equal(skillCommandProblem(command),undefined,command)
  assert.deepEqual(commandWords('"C:\\Program Files\\node.exe" -e "console.log(1)"'),['C:\\Program Files\\node.exe','-e','console.log(1)'])
})
test('new contracts do not add independent review for complexity or delegation alone',()=>{
  const caps={spawn:true,fork:true,reviewer:true},delivery=deliveryContract('implementation','requested change')
  for(const complexity of ['high','ultra'])for(const mode of ['direct','spawn','fork'])assert.equal(reviewStrategy({delivery,complexity,risk_level:'standard'},mode,caps).review,'main')
  assert.equal(reviewStrategy({delivery,risk_level:'high_risk'},'direct',caps).review,'independent')
  assert.equal(reviewStrategy({complexity:'high',risk_level:'standard'},'direct',caps).review,'independent')
})
