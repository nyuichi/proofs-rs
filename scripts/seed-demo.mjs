import {readFileSync,writeFileSync} from 'node:fs';
import {demoDraft,demoRecords,demoSarif} from '../app/lib/demo-data.ts';
const config=JSON.parse(readFileSync('wrangler.dev.json','utf8'));
if(config.name!=='proofs-rs-dev'||config.d1_databases?.[0]?.database_name!=='proofs-rs-dev-db')throw new Error('Demo seed must target development only.');
const q=v=>v==null?'NULL':"'"+String(v).replaceAll("'","''")+"'";
const insert=(t,fields,values)=>`INSERT OR IGNORE INTO ${t} (${fields.join(',')}) VALUES (${values.map(q).join(',')});`;
const lines=['-- Synthetic demonstration only. No real verification is asserted.'];
for(const [id,login]of [['demo-author-a','demo-mika'],['demo-author-b','demo-ren']])lines.push(insert('publishers',['id','github_user_id','github_login','created_at'],[id,id,login,'2026-09-01T00:00:00.000Z']));
const draft=demoDraft();
const pubFields=['id','publisher_id','message','crate_name','crate_version','upstream_repository','upstream_commit','upstream_path','verification_repository','verification_commit','verification_path','sarif_version','created_at'];
const pubs=[
 ['demo-v2-fnv-baseline','demo-author-a','[DEMO] Baseline: construction, writes and finish','1.0.7','2026-09-01T10:00:00.000Z'],
 ['demo-v2-fnv-expanded','demo-author-b','[DEMO] Expand write bounds; retain construction; omit finish','1.0.7','2026-09-02T10:00:00.000Z'],
 ['demo-v2-fnv-old-version','demo-author-a','[DEMO] Previous release baseline','1.0.6','2026-09-03T10:00:00.000Z'],
];
for(const [id,author,title,version,date]of pubs){
 lines.push(insert('publications',pubFields,[id,author,title+'\n\nSynthetic demo data. Zero commit hashes are placeholders, not upstream or verification revisions.','fnv',version,draft.upstream_repository,draft.upstream_commit,draft.upstream_path,draft.verification_repository,draft.verification_commit,draft.verification_path,'2.1.0',date]));
 lines.push(insert('sarif_runs',['publication_id','run_index','run_json'],[id,0,JSON.stringify(demoSarif.runs[0])]));
 lines.push(insert('publication_labels',['publication_id','position','display_name','normalized_name'],[id,0,'demo','demo']));
}
const fields=['id','publication_id','api_path','api_kind','tag','contract','configuration','run_index','result_index','supersedes_id','api_safety','contract_language'];
function record(id,pub,r,parent=null){lines.push(insert('verification_records',fields,[id,pub,r.api_path,r.api_kind,r.tag,r.contract,r.configuration,r.run_index,r.result_index,parent,r.api_safety,r.contract_language]));}
function member(pub,id,n){lines.push(insert('publication_records',['publication_id','record_id','position'],[pub,id,n]));}
demoRecords.forEach((r,i)=>{record('demo-v2-result-'+i,'demo-v2-fnv-baseline',r);member('demo-v2-fnv-baseline','demo-v2-result-'+i,i);});
const expanded={...demoRecords[1],contract:'kani::assume(bytes.len() <= 32);',configuration:'default features; x86_64-unknown-linux-gnu; unwind 33'};
record('demo-v2-result-expanded','demo-v2-fnv-expanded',expanded,'demo-v2-result-1');
member('demo-v2-fnv-expanded','demo-v2-result-0',0);member('demo-v2-fnv-expanded','demo-v2-result-expanded',1);member('demo-v2-fnv-expanded','demo-v2-result-3',2);
record('demo-v2-result-old','demo-v2-fnv-old-version',demoRecords[0]);member('demo-v2-fnv-old-version','demo-v2-result-old',0);
const unsafePub='demo-arrayvec-safety';
lines.push(insert('publications',pubFields,[unsafePub,'demo-author-b','[DEMO] Unsafe ArrayVec insertion: no UB and no panic\n\nSynthetic evidence; source revisions are placeholders.','arrayvec','0.7.6','bluss/arrayvec','0000000000000000000000000000000000000000','src/arrayvec.rs',draft.verification_repository,draft.verification_commit,'fixtures','2.1.0','2026-09-04T10:00:00.000Z']));
const unsafeRun=structuredClone(demoSarif.runs[0]);
unsafeRun.results=unsafeRun.results.slice(0,2).map((result,i)=>({...result,ruleId:i===0?'demo.no-ub':'demo.no-panic',message:{text:'DEMO ONLY: simulated check of push_unchecked under its capacity precondition.'},locations:[{logicalLocations:[{fullyQualifiedName:'arrayvec::ArrayVec::push_unchecked',kind:'function'}]}]}));
lines.push(insert('sarif_runs',['publication_id','run_index','run_json'],[unsafePub,0,JSON.stringify(unsafeRun)]));
lines.push(insert('publication_labels',['publication_id','position','display_name','normalized_name'],[unsafePub,0,'demo','demo']));
for(const [i,tag]of ['no-ub','no-panic'].entries()){
 const r={api_path:'arrayvec::ArrayVec::push_unchecked',api_kind:'method',api_safety:'unsafe',contract_language:'kani',tag,contract:'kani::assume(vec.len() < CAPACITY);',configuration:'ArrayVec<u8, CAPACITY>; CAPACITY = 8; default features; x86_64-unknown-linux-gnu; synthetic evidence',run_index:0,result_index:i};
 record('demo-arrayvec-result-'+i,unsafePub,r);member(unsafePub,'demo-arrayvec-result-'+i,i);
}
writeFileSync('fixtures/demo.sql',lines.join('\n')+'\n');
