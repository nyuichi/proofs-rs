import {describe,it,expect,vi} from 'vitest';
import {fetchCrate} from '../app/lib/crates.server';
import {isDemoMode} from '../app/lib/demo.server';
describe('crate metadata',()=>{
 it('chooses latest stable release, preserves version choices and canonical name',async()=>{
 const fetcher=vi.fn(async()=>Response.json({crate:{name:'fnv',description:'FNV hasher',max_stable_version:'1.0.7',max_version:'2.0.0-beta.1'},versions:[{num:'2.0.0-beta.1',yanked:false},{num:'1.0.7',yanked:false}]}));
 expect(await fetchCrate('fnv',fetcher)).toMatchObject({name:'fnv',latest:'1.0.7',versions:['2.0.0-beta.1','1.0.7']});
 });
 it('distinguishes missing crates and registry outages',async()=>{
 await expect(fetchCrate('missing',async()=>new Response('',{status:404}))).rejects.toMatchObject({status:404});
 await expect(fetchCrate('fnv',async()=>new Response('',{status:429}))).rejects.toMatchObject({status:503});
 await expect(fetchCrate('../bad')).rejects.toMatchObject({status:400});
 });
 it('never enables demo authentication in production',()=>{
 expect(isDemoMode({APP_ORIGIN:'https://proofs-rs.proofs-rs.workers.dev',APP_ENV:'development',DEMO_MODE:'true'})).toBe(false);
 expect(isDemoMode({APP_ORIGIN:'https://dev.example',DEMO_MODE:'true'})).toBe(false);
 expect(isDemoMode({APP_ORIGIN:'https://dev.example',APP_ENV:'development',DEMO_MODE:'true'})).toBe(true);
 });
});
