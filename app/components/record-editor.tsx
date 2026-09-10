import {useState} from 'react';
import type {RecordInput,VerificationRecord} from '../lib/records.server';
export function RecordEditor({initial=[],available=[],selected}: {initial?:RecordInput[];available?:VerificationRecord[];selected?:string[]}) {
 const [rows,setRows]=useState(initial);
 const [retained,setRetained]=useState(selected ?? available.map(r=>r.id));
 const edit=(i:number,key:keyof RecordInput,value:string|number)=>setRows(rows.map((r,j)=>j===i?{...r,[key]:value}:r));
 const add=()=>setRows([...rows,{api_path:'',api_kind:'function',tag:'no-panic',contract:'',configuration:'default features; x86_64-unknown-linux-gnu',run_index:0,result_index:0}]);
 return <section className="form-section"><h2>API verification results</h2><p>Declare public functions or methods and the contracts covered by your evidence. Evidence numbers start at 1.</p>
 <input type="hidden" name="records" value={JSON.stringify(rows)}/><input type="hidden" name="inherited" value={JSON.stringify(retained)}/>
 {available.length>0&&<fieldset><legend>Retain results from the source publication</legend>{available.map(r=><div className="inherit-row" key={r.id}><label><input type="checkbox" checked={retained.includes(r.id)} onChange={e=>setRetained(e.target.checked?[...retained,r.id]:retained.filter(id=>id!==r.id))}/><code>{r.api_path}</code> · {r.tag} · {r.publisher_login}</label><button type="button" className="auth-button" disabled={rows.some(row=>row.supersedes_id===r.id)} onClick={()=>{setRetained(retained.filter(id=>id!==r.id));setRows([...rows,{api_path:r.api_path,api_kind:r.api_kind,tag:r.tag,contract:r.contract,configuration:r.configuration,run_index:0,result_index:0,supersedes_id:r.id}]);}}>Replace with new evidence</button></div>)}</fieldset>}
 {rows.map((r,i)=><fieldset className="record-editor" key={i}><legend>Result {i+1}{r.supersedes_id?' · revision':''}</legend><div className="form-grid">
 <label>Public API path<input required value={r.api_path} onChange={e=>edit(i,'api_path',e.target.value)} placeholder="fnv::FnvHasher::write"/></label>
 <label>Kind<select value={r.api_kind} onChange={e=>edit(i,'api_kind',e.target.value)}><option value="function">Function</option><option value="method">Method</option></select></label>
 <label>Property<select value={r.tag} onChange={e=>edit(i,'tag',e.target.value)}><option value="no-panic">no panic</option><option value="no-ub">no UB</option></select></label>
 <label>Build configuration<input required value={r.configuration} onChange={e=>edit(i,'configuration',e.target.value)}/></label>
 <label className="form-field-wide">Contract<textarea required rows={3} value={r.contract} onChange={e=>edit(i,'contract',e.target.value)} placeholder="Preconditions and bounds of the verification"/></label>
 <label>SARIF run number<input type="number" min={1} required value={r.run_index+1} onChange={e=>edit(i,'run_index',Number(e.target.value)-1)}/></label><label>Result number in run<input type="number" min={1} required value={r.result_index+1} onChange={e=>edit(i,'result_index',Number(e.target.value)-1)}/></label>
 </div><button className="auth-button" type="button" onClick={()=>setRows(rows.filter((_,j)=>i!==j))}>Remove result</button></fieldset>)}
 <button className="auth-button" type="button" onClick={add}>+ Add API result</button><p className="form-note">Tags are publisher assertions under the stated contracts. The site does not rerun verification.</p></section>;
}
