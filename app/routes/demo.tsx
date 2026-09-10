import {env} from 'cloudflare:workers';
import {Form,Link,redirect} from 'react-router';
import type {Route} from './+types/demo';
import {isDemoMode} from '../lib/demo.server';
import {assertSameOrigin,createSession,serializeCookie,sessionCookieName,normalizeReturnTo} from '../lib/auth.server';
import {upsertPublisher} from '../lib/repository.server';
export async function loader({request}:Route.LoaderArgs) {
 if(!isDemoMode(env)) throw new Response('Not found',{status:404});
 return {returnTo:normalizeReturnTo(request,new URL(request.url).searchParams.get('returnTo'))};
}
export async function action({request}:Route.ActionArgs) {
 if(!isDemoMode(env)) throw new Response('Not found',{status:404});
 assertSameOrigin(request,env);
 const form=await request.formData();
 const publisher=await upsertPublisher(env.DB,'demo-visitor','demo-visitor');
 const {token}=await createSession(env.DB,publisher.id);
 return redirect(normalizeReturnTo(request,String(form.get('returnTo') || '/publish?demo=1')), {status:303,headers:{'Set-Cookie':serializeCookie(sessionCookieName(request),token,{httpOnly:true,secure:new URL(request.url).protocol==='https:',sameSite:'Lax',path:'/',maxAge:86400})}});
}
export default function Demo({loaderData}:Route.ComponentProps){return <main className="page-shell"><section className="page-heading"><p className="eyebrow">Development sandbox</p><h1>Try the complete flow</h1><p className="lede">All seeded publications are synthetic examples, not actual verification results. This sandbox has its own database.</p></section><ol className="pub-history"><li><Link to="/crates/fnv?version=1.0.7">FNV 1.0.7: inherited, revised and omitted results</Link></li><li><Link to="/crates/fnv?version=1.0.6">FNV 1.0.6: a separate version snapshot</Link></li><li><Link to="/crates/serde">An unpublished crate</Link></li></ol><Form method="post"><input type="hidden" name="returnTo" value={loaderData.returnTo==='/'?'/publish?demo=1':loaderData.returnTo}/><button className="primary-button" type="submit">Continue as demo visitor</button><p>No GitHub account required. Demo writes are shared within this development sandbox.</p></Form></main>;}
