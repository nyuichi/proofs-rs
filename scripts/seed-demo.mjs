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
 ['demo-fnv-baseline','demo-author-a','[DEMO] Baseline: construction, writes and finish','1.0.7','2026-09-01T10:00:00.000Z'],
 ['demo-fnv-expanded','demo-author-b','[DEMO] Expand write bounds; retain construction; omit finish','1.0.7','2026-09-02T10:00:00.000Z'],
 ['demo-fnv-old-version','demo-author-a','[DEMO] Previous release baseline','1.0.6','2026-09-03T10:00:00.000Z'],
];
for(const [id,author,title,version,date]of pubs){
 lines.push(insert('publications',pubFields,[id,author,title+'\n\nSynthetic demo data. Zero commit hashes are placeholders, not upstream or verification revisions.','fnv',version,draft.upstream_repository,draft.upstream_commit,draft.upstream_path,draft.verification_repository,draft.verification_commit,draft.verification_path,'2.1.0',date]));
 lines.push(insert('sarif_runs',['publication_id','run_index','run_json'],[id,0,JSON.stringify(demoSarif.runs[0])]));
 lines.push(insert('publication_labels',['publication_id','position','display_name','normalized_name'],[id,0,'demo','demo']));
}
const fields=['id','publication_id','api_path','api_kind','tag','contract','configuration','run_index','result_index','supersedes_id'];
function record(id,pub,r,parent=null){lines.push(insert('verification_records',fields,[id,pub,r.api_path,r.api_kind,r.tag,r.contract,r.configuration,r.run_index,r.result_index,parent]));}
function member(pub,id,n){lines.push(insert('publication_records',['publication_id','record_id','position'],[pub,id,n]));}
demoRecords.forEach((r,i)=>{record('demo-result-'+i,'demo-fnv-baseline',r);member('demo-fnv-baseline','demo-result-'+i,i);});
const expanded={...demoRecords[1],contract:'Valid byte slice of length 0..=32; arbitrary initial u64 hash state. Synthetic expanded-bound demonstration.',configuration:'default features; x86_64-unknown-linux-gnu; unwind 33'};
record('demo-result-expanded','demo-fnv-expanded',expanded,'demo-result-1');
member('demo-fnv-expanded','demo-result-0',0);member('demo-fnv-expanded','demo-result-expanded',1);
record('demo-result-old','demo-fnv-old-version',demoRecords[0]);member('demo-fnv-old-version','demo-result-old',0);
writeFileSync('fixtures/demo.sql',lines.join('\n')+'\n');
