export interface CrateInfo { name: string; description: string; versions: string[]; latest: string; }
export const validCrateName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export async function fetchCrate(name: string, fetcher: typeof fetch = fetch): Promise<CrateInfo> {
 if (!validCrateName.test(name)) throw new Response('Invalid crate name', {status:400});
 let response: Response;
 try { response=await fetcher(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, { headers: { 'User-Agent':'proofs.rs crate browser (https://github.com/nyuichi/proofs-rs)', Accept:'application/json' }, signal: AbortSignal.timeout(8000) }); }
 catch { throw new Response('Crate registry temporarily unavailable. Please retry.', {status:503}); }
 if (response.status===404) throw new Response('Crate not found', {status:404});
 if (!response.ok) throw new Response('Crate registry temporarily unavailable. Please retry.', {status:503});
 const body = await response.json() as {crate:{name:string; description:string; max_stable_version?:string; max_version:string}; versions:{num:string;yanked:boolean}[]};
 return {name:body.crate.name,description:body.crate.description ?? '', latest:body.crate.max_stable_version || body.crate.max_version,versions:body.versions.map(v=>v.num)};
}
