export function isDemoMode(env: {APP_ORIGIN?:string; APP_ENV?:string; DEMO_MODE?:string}) {
 return env.APP_ENV==='development' && env.DEMO_MODE==='true' && Boolean(env.APP_ORIGIN) && env.APP_ORIGIN!=='https://proofs-rs.proofs-rs.workers.dev';
}
