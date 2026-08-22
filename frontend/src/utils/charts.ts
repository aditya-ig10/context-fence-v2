export const CC=['#ff5a5f','#00a699','#fcb400','#6366f1','#34d399','#f472b6','#fbbf24','#a78bfa'];
export function fn(n:number):string{if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toString()}
