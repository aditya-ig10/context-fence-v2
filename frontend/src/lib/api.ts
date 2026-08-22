const BASE='/api';
export async function api(p:string,o?:RequestInit){const r=await fetch(`${BASE}${p}`,{headers:{'Content-Type':'application/json'},...o});if(!r.ok)throw new Error(await r.text());return r.json()}
