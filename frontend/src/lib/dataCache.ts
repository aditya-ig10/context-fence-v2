// v2: shared data cache used by useCachedFetch
const mem = new Map<string, { data:any; ts:number }>();
export function getCache<T>(k:string, maxAgeMs:number): T|null {
  const v=mem.get(k); if(!v) return null;
  if(Date.now()-v.ts>maxAgeMs) { mem.delete(k); return null; }
  return v.data as T;
}
export function setCache(k:string, data:any){ mem.set(k,{data, ts:Date.now()}); }
export function clearCache(k?:string){ if(k) mem.delete(k); else mem.clear(); }
