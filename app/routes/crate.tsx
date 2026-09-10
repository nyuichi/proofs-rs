import { env } from 'cloudflare:workers';
import { Form, Link, redirect } from 'react-router';
import type { Route } from './+types/crate';
import { fetchCrate } from '../lib/crates.server';
import { cratePublications } from '../lib/repository.server';
import { getPublicationRecords } from '../lib/records.server';
import { VerificationList } from '../components/verification-list';
import { splitPublicationMessage } from '../lib/presentation';
export async function loader({params,request}:Route.LoaderArgs) {
 const info=await fetchCrate(params.name);
 const url=new URL(request.url); const version=url.searchParams.get('version') || info.latest;
 if (!info.versions.includes(version)) throw new Response('Crate version not found',{status:404});
 if (info.name!==params.name) throw redirect(`/crates/${encodeURIComponent(info.name)}?version=${encodeURIComponent(version)}`);
 const publications=await cratePublications(env.DB,info.name,version);
 const records=publications[0] ? await getPublicationRecords(env.DB,publications[0].id) : [];
 return {info,version,publications,records};
}
export function meta({loaderData}:Route.MetaArgs) { return [{title:`${loaderData?.info.name ?? 'Crate'} · proofs.rs`}]; }
export default function Crate({loaderData:{info,version,publications,records}}:Route.ComponentProps) {
 const latest=publications[0];
 return <main className="page-shell detail-page"><section className="page-heading"><p className="eyebrow">Crate verification</p><h1>{info.name}</h1><p className="lede">{info.description}</p>
 <div className="crate-controls"><Form method="get"><label htmlFor="version">Version </label><select id="version" name="version" defaultValue={version}>{info.versions.map(v=><option key={v}>{v}</option>)}</select><button type="submit" className="auth-button">View</button></Form><a href={`https://crates.io/crates/${info.name}/${version}`}>crates.io ↗</a><Link className="primary-button" to={latest?`/publish?from=${latest.id}`:`/publish?crate=${info.name}&version=${version}`}>{latest?'Build on this publication':'Publish results'}</Link></div></section>
 {latest?<section className="snapshot-banner"><p className="eyebrow">Latest publication · {latest.publisher_login}</p><Link to={`/publications/${latest.id}`}>{splitPublicationMessage(latest.message).title}</Link><p>{new Date(latest.created_at).toISOString()} · {new Set(records.map(r=>r.api_path)).size} APIs with mapped results</p><p className="form-note">Only results included in this publication are shown. Earlier results are not merged automatically.</p></section>:<section className="empty-state"><h2>No verification results yet</h2><p>No publication for {info.name} {version} has been submitted.</p></section>}
 {records.length>0?<VerificationList records={records}/>:latest?<section className="empty-state"><h2>No mapped API results</h2><p>This publication has no explicit API/tag mappings. Its original SARIF is available on the publication page.</p></section>:null}
 <section className="form-section"><h2>Publication history</h2>{publications.length===0?<p>No publications.</p>:<ol className="pub-history">{publications.map((p,i)=><li key={p.id}><Link to={`/publications/${p.id}`}>{splitPublicationMessage(p.message).title}</Link> <span>{p.publisher_login} · {p.created_at.slice(0,10)}{i===0?' · current':''}</span></li>)}</ol>}</section>
 </main>;
}
