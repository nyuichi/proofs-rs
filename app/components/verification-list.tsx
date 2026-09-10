import { Link } from 'react-router';
import type { VerificationRecord } from '../lib/records.server';
export function VerificationList({records}: {records: VerificationRecord[]}) {
 const groups = new Map<string, Map<string, VerificationRecord[]>>();
 for (const r of records) {
  const scope=r.api_path.split('::').slice(0,-1).join('::') || 'crate root';
  if (!groups.has(scope)) groups.set(scope,new Map());
  const apis=groups.get(scope)!; apis.set(r.api_path,[...(apis.get(r.api_path) ?? []),r]);
 }
 return <div className="verification-list">{[...groups].sort().map(([scope,apis])=><section key={scope} className="api-scope"><h2>{scope}</h2>{[...apis].sort().map(([api,results])=><article className="api-record" key={api}>
  <h3><code>{api}</code></h3><p className="form-note">Public {results[0].api_kind} · {results.length} result{results.length>1?'s':''}</p>
  {results.map(r=><details key={r.id} className="verification-result"><summary><span className="verification-tag">{r.tag==='no-ub'?'no UB':'no panic'}</span><span>under the stated contract</span><span className="blame-author">{r.publisher_login}</span></summary>
   <dl><dt>Contract</dt><dd className="contract-text">{r.contract}</dd><dt>Configuration</dt><dd>{r.configuration}</dd><dt>Tool</dt><dd>{r.tool_name} {r.tool_version}</dd><dt>Evidence</dt><dd>{r.evidence_message}</dd></dl>
   <div className="record-links"><Link to={`/results/${r.id}`}>Blame & history</Link><Link to={`/publications/${r.publication_id}`}>Source publication · {new Date(r.created_at).toLocaleDateString('en-GB',{timeZone:'UTC'})}</Link></div>
  </details>)}
 </article>)}</section>)}</div>;
}
