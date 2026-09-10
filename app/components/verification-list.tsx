import { Link } from 'react-router';
import type { VerificationRecord } from '../lib/records.server';
const tagName=(tag:string)=>tag==='no-ub'?'no UB':'no panic';
export function ContractSource({record:r}:{record:VerificationRecord}) {
 if(r.contract_language==='legacy')return <p className="form-note">Legacy record: contract source was not supplied. See the original publication for its prose description.</p>;
 if(!r.contract.trim())return <p>No additional preconditions.</p>;
 return <div><p className="contract-language">{r.contract_language}</p><pre className="contract-code"><code>{r.contract}</code></pre></div>;
}
export function VerificationList({records}: {records: VerificationRecord[]}) {
 const groups = new Map<string, Map<string, VerificationRecord[]>>();
 for (const r of records) {
  const scope=r.api_path.split('::').slice(0,-1).join('::') || 'crate root';
  if (!groups.has(scope)) groups.set(scope,new Map());
  const apis=groups.get(scope)!; apis.set(r.api_path,[...(apis.get(r.api_path) ?? []),r]);
 }
 return <div className="verification-list">{[...groups].sort().map(([scope,apis])=><section key={scope} className="api-scope"><h2>{scope}</h2>{[...apis].sort().map(([api,results])=><article className="api-record" key={api}>
  <h3>{results.some(r=>r.api_safety==='unsafe')?<span className="unsafe-badge">unsafe fn</span>:results.every(r=>r.api_safety==='safe')?<span className="safe-badge">safe fn</span>:<span className="safe-badge">Safety unspecified</span>} <code>{api}</code></h3>
  <div className="api-properties">{[...new Set(results.map(r=>r.tag))].map(tag=><span className="verification-tag" key={tag}>{tagName(tag)}</span>)}</div>
  <p className="form-note">Public {results[0].api_kind} · {results.length} result{results.length>1?'s':''}</p>
  {results.map(r=><details key={r.id} className="verification-result"><summary><span className="verification-tag">{tagName(r.tag)}</span><span>{r.contract_language==='legacy'?'Contract source unavailable':r.api_safety==='unsafe'?'Under the safety contract':r.contract.trim()?'Under the contract':'No additional preconditions'}</span><span className="blame-author">{r.publisher_login}</span></summary>
   <dl><dt>{r.api_safety==='unsafe'?'Safety contract (source)':'Contract (source)'}</dt><dd><ContractSource record={r}/></dd><dt>Configuration / verification scope</dt><dd>{r.configuration}</dd><dt>Tool</dt><dd>{r.tool_name} {r.tool_version}</dd><dt>Evidence</dt><dd>{r.evidence_message}</dd></dl>
   <div className="record-links"><Link to={`/results/${r.id}`}>Blame & history</Link><Link to={`/publications/${r.publication_id}`}>Source publication · {new Date(r.created_at).toLocaleDateString('en-GB',{timeZone:'UTC'})}</Link></div>
  </details>)}
 </article>)}</section>)}</div>;
}
