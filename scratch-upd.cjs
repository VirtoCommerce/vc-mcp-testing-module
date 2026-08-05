const fs=require('fs');
const P='reports/regression/REG-2026-08-05-1416/suite-002-results.json';
const [,,id,status,...rest]=process.argv;
const extra=rest.length?JSON.parse(rest.join(' ')):{};
const j=JSON.parse(fs.readFileSync(P,'utf8'));
const c=j.testCases.find(t=>t.id===id);
if(!c){console.error('no case',id);process.exit(1)}
c.status=status; Object.assign(c,extra);
if(status==='PASS'){for(const k of ['failedAssertion','screenshot','trace','consoleErrors','networkErrors']) delete c[k];}
j.passed=j.testCases.filter(t=>t.status==='PASS').length;
j.failed=j.testCases.filter(t=>t.status==='FAIL').length;
j.blocked=j.testCases.filter(t=>t.status==='BLOCKED').length;
j.skipped=j.testCases.filter(t=>t.status==='SKIPPED').length;
j.passRate=(j.passed/j.totalCases*100).toFixed(1)+'%';
fs.writeFileSync(P,JSON.stringify(j,null,2));
console.log(id,'->',status,'| P',j.passed,'F',j.failed,'B',j.blocked,'S',j.skipped);
