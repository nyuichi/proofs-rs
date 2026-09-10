import {env} from 'cloudflare:workers';
import {beforeEach,describe,it,expect} from 'vitest';
import {createPublication,cratePublications,upsertPublisher} from '../app/lib/repository.server';
import {getPublicationRecords,recordHistory,RecordValidationError} from '../app/lib/records.server';
import {demoDraft,demoRecords,demoSarif} from '../app/lib/demo-data';
import {parsePublicationMetadata} from '../app/lib/metadata';
import {parseSarif} from '../app/lib/sarif';
const db=env.DB;
async function clear(){await db.batch(['DELETE FROM publication_records','UPDATE verification_records SET supersedes_id=NULL','DELETE FROM verification_records','DELETE FROM sarif_runs','DELETE FROM publications','DELETE FROM sessions','DELETE FROM publishers'].map(s=>db.prepare(s)));}
const meta=()=>parsePublicationMetadata({...demoDraft(),labels:['demo']});
const sarif=()=>parseSarif(JSON.stringify(demoSarif));
async function pub(publisherId:string,options:Partial<Parameters<typeof createPublication>[0]>={}){return createPublication({db,publisherId,metadata:meta(),sarif:sarif(),records:demoRecords, ...options});}
describe('crate snapshots and provenance',()=>{
 beforeEach(clear);
 it('uses newest publication regardless of author; omits old results; keeps exact provenance',async()=>{
  const a=await upsertPublisher(db,'a','author-a'),b=await upsertPublisher(db,'b','author-b');
  const first=await pub(a.id,{now:new Date('2026-09-01T00:00:00Z')});
  const original=await getPublicationRecords(db,first);
  const latest=await pub(b.id,{now:new Date('2026-09-02T00:00:00Z'),records:[{...demoRecords[1],contract:'Expanded: length <= 32',supersedes_id:original[1].id}],inheritedRecordIds:[original[0].id]});
  expect((await cratePublications(db,'fnv','1.0.7')).map(p=>p.id)).toEqual([latest,first]);
  const results=await getPublicationRecords(db,latest);
  expect(results).toHaveLength(2);
  expect(results[0].id).toBe(original[0].id);
  expect(results[0].publisher_login).toBe('author-a');
  expect(results[1].publisher_login).toBe('author-b');
  expect(results.some(r=>r.api_path.endsWith('finish'))).toBe(false);
  expect((await recordHistory(db,results[1].id)).map(r=>r.id)).toEqual([results[1].id,original[1].id]);
  expect(await getPublicationRecords(db,first)).toHaveLength(3);
  expect(await cratePublications(db,'fnv','1.0.6')).toEqual([]);
 });
 it('rejects cross-version inheritance and invalid evidence atomically',async()=>{
  const a=await upsertPublisher(db,'a','author-a');
  const id=await pub(a.id);const records=await getPublicationRecords(db,id);
  await expect(pub(a.id,{metadata:{...meta(),crate_version:'1.0.6'},records:[],inheritedRecordIds:[records[0].id]})).rejects.toBeInstanceOf(RecordValidationError);
  await expect(pub(a.id,{records:[{...demoRecords[0],result_index:99}]})).rejects.toBeInstanceOf(RecordValidationError);
  await expect(pub(a.id,{records:[{...demoRecords[1],supersedes_id:records[0].id}]})).rejects.toBeInstanceOf(RecordValidationError);
  await expect(pub(a.id,{records:[{...demoRecords[0],supersedes_id:records[0].id}],inheritedRecordIds:[records[0].id]})).rejects.toBeInstanceOf(RecordValidationError);
  expect(await cratePublications(db,'fnv','1.0.7')).toHaveLength(1);
 });
 it('does not invent mappings or tags for legacy SARIF',async()=>{
  const a=await upsertPublisher(db,'a','author-a');const id=await pub(a.id,{records:[]});
  expect(await getPublicationRecords(db,id)).toEqual([]);
 });
 it('retains different contracts for the same API and tag',async()=>{
  const a=await upsertPublisher(db,'a','author-a');const id=await pub(a.id,{records:[demoRecords[1],{...demoRecords[1],contract:'Length <= 8; a separate configuration',configuration:'no-default-features'}]});
  expect(await getPublicationRecords(db,id)).toHaveLength(2);
 });
 it('rejects failed evidence and unsupported tags',async()=>{
  const a=await upsertPublisher(db,'a','author-a');const failed=sarif();failed.runs[0].results![0].kind='fail';
  await expect(pub(a.id,{sarif:failed,records:[demoRecords[0]]})).rejects.toBeInstanceOf(RecordValidationError);
  await expect(pub(a.id,{records:[{...demoRecords[0],tag:'no-unsafe'}]})).rejects.toThrow();
 });
});
