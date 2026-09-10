import {readFileSync,appendFileSync} from 'node:fs';
import {demoDraft} from '../app/lib/demo-data.ts';
const origin=readFileSync('.dev-origin','utf8').trim();
if(!origin.startsWith('https://proofs-rs-dev.'))throw new Error('Not a development URL.');
// Read-only checks tolerate edge propagation after a deployment; writes are never retried.
async function check(path,pattern){
 for(let attempt=0;;attempt++){
  const r=await fetch(origin+path);const html=await r.text();
  if(r.ok&&html.includes(pattern))return html;
  if(attempt>=5)throw new Error(`Smoke check failed: ${path} (${r.status})`);
  await new Promise(resolve=>setTimeout(resolve,5000));
 }
}
await check('/','Development sandbox');
await check('/demo','Try the complete flow');
const crate=await check('/publications/demo-v2-fnv-expanded','demo-v2-result-expanded');
if(crate.includes('<code>fnv::FnvHasher::finish</code>'))throw new Error('Omitted result leaked into latest snapshot.');
await check('/results/demo-v2-result-expanded','demo-v2-result-1');
await check('/crates/fnv?version=1.0.6','Previous release baseline');
await check('/crates/arrayvec?version=0.7.6','unsafe fn');
await check('/results/demo-arrayvec-result-0','kani::assume(vec.len() &lt; CAPACITY);');
await check('/crates/serde','No verification results yet');
const search=await fetch(origin+'/?q=fnv',{redirect:'manual'});
if(search.headers.get('location')!=='/crates/fnv')throw new Error('Search redirect failed.');
const login=await fetch(origin+'/demo',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({returnTo:'/publish?demo=1'}),redirect:'manual'});
const cookie=login.headers.get('set-cookie')?.split(';')[0];
if(login.status!==303||!cookie)throw new Error('Demo login failed.');
const draft=demoDraft();draft.message='[DEMO] Automated end-to-end publication\n\nSynthetic smoke-test data.';
const published=await fetch(origin+'/publish',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:new URLSearchParams(draft),redirect:'manual'});
const location=published.headers.get('location');
if(published.status!==303||!location?.startsWith('/publications/'))throw new Error(`Publication failed: ${published.status}`);
await check(location,'Automated end-to-end publication');
// Preserve the most recent demo history while proving a inherited-only snapshot can be posted.
const inherited={...draft,records:'[]',inherited:JSON.stringify(['demo-v2-result-0','demo-v2-result-expanded','demo-v2-result-3']),message:'[DEMO] Latest snapshot: preserve attribution\n\nRetains construction and revised writes; finish remains omitted.'};
const next=await fetch(origin+'/publish',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:new URLSearchParams(inherited),redirect:'manual'});
if(next.status!==303)throw new Error('Inheritance publication failed.');
const latest=await check('/crates/fnv?version=1.0.7','demo-v2-result-expanded');
if(latest.includes('<code>fnv::FnvHasher::finish</code>'))throw new Error('Omitted result leaked into latest snapshot.');
const denied=await fetch(origin+'/publish',{method:'POST',headers:{Origin:'https://untrusted.example',Cookie:cookie},body:new URLSearchParams(draft),redirect:'manual'});
if(denied.status!==403)throw new Error(`Cross-origin POST returned ${denied.status}: ${(await denied.text()).slice(0,200)}`);
console.log(`Verified development browsing, login, posting, inheritance and origin protection: ${origin}`);
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\nDevelopment demo: ${origin}/demo\n\nSmoke checks passed. All example results are synthetic.\n`);
