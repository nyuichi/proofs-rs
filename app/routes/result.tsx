import {env} from 'cloudflare:workers';
import {Link} from 'react-router';
import type {Route} from './+types/result';
import {recordHistory} from '../lib/records.server';
import {VerificationList} from '../components/verification-list';
export async function loader({params}:Route.LoaderArgs) {
 const history=await recordHistory(env.DB,params.id);
 if(!history.length) throw new Response('Result not found',{status:404});
 const usages=await env.DB.prepare('SELECT p.id,p.message,p.created_at FROM publication_records m JOIN publications p ON p.id=m.publication_id WHERE m.record_id=? ORDER BY p.created_at DESC,p.id DESC LIMIT 100').bind(params.id).all<{id:string;message:string;created_at:string}>();
 return {history,usages:usages.results};
}
export default function Result({loaderData:{history,usages}}:Route.ComponentProps) {
 const r=history[0];return <main className="page-shell detail-page"><p className="eyebrow">Result provenance</p><h1>Blame & history</h1><Link to={`/crates/${r.crate_name}?version=${r.crate_version}`}>{r.crate_name} {r.crate_version}</Link><VerificationList records={[r]}/><section className="form-section"><h2>Result revisions</h2><ol className="pub-history">{history.map(item=><li key={item.id}><Link to={`/results/${item.id}`}>{item.publisher_login} · {item.created_at}</Link><p className="contract-text">{item.contract}</p><Link to={`/publications/${item.publication_id}`}>Origin publication</Link></li>)}</ol></section><section className="form-section"><h2>Included in publications</h2>{usages.map(p=><p key={p.id}><Link to={`/publications/${p.id}`}>{p.message.split('\n')[0]}</Link></p>)}</section></main>;
}
