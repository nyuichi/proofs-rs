import type {RecordInput} from './records.server';
// Synthetic evidence for exercising the UI. These are NOT actual verifier runs.
export const demoRecords: RecordInput[] = [
 {api_path:'fnv::FnvHasher::default',api_kind:'method',tag:'no-panic',contract:'Default construction; no additional preconditions. Synthetic demonstration only.',configuration:'default features; x86_64-unknown-linux-gnu',run_index:0,result_index:0},
 {api_path:'fnv::FnvHasher::write',api_kind:'method',tag:'no-ub',contract:'Valid byte slice of length 0..=16 and arbitrary initial u64 hash state. Bounds are part of this demo claim.',configuration:'default features; x86_64-unknown-linux-gnu; unwind 17',run_index:0,result_index:1},
 {api_path:'fnv::FnvHasher::finish',api_kind:'method',tag:'no-panic',contract:'Any initialized FnvHasher. Reading the hash must preserve its state. Synthetic demonstration only.',configuration:'default features; x86_64-unknown-linux-gnu',run_index:0,result_index:2},
];
export const demoSarif={version:'2.1.0',runs:[{tool:{driver:{name:'Kani (synthetic demo)',version:'0.66.0',rules:[{id:'demo.no-panic',shortDescription:{text:'No panic under the stated contract'}},{id:'demo.no-ub',shortDescription:{text:'No undefined behavior under the stated contract'}}]}},properties:{configuration:'default features; x86_64-unknown-linux-gnu',synthetic:true},results:demoRecords.map((r,i)=>({ruleId:`demo.${r.tag}`,kind:'pass',level:'none',message:{text:`DEMO ONLY: simulated successful check for ${r.api_path}; not a real proof.`},locations:[{logicalLocations:[{fullyQualifiedName:r.api_path,kind:'function'}],physicalLocation:{artifactLocation:{uri:'fnv_demo.rs'},region:{startLine:8+i*12}}}]}))}]};
export function demoDraft(){return {
 message:'[DEMO] FNV hash-state safety\n\nSynthetic publication for exploring contracts, evidence and attribution. No real verification is claimed.',
 crate_name:'fnv',crate_version:'1.0.7',upstream_repository:'servo/rust-fnv',upstream_commit:'4b4784ebfd3332dc61f0640764d6f1140e03a9ab',upstream_path:'lib.rs',
 verification_repository:'nyuichi/proofs-rs',verification_commit:'3734c430c6e8397eaca494e0c32bf56f406d2bcc',verification_path:'fixtures',
 labels:'demo',sarif:JSON.stringify(demoSarif,null,2),records:JSON.stringify(demoRecords),inherited:'[]',source:''
};}
