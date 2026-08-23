import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rateLimiter, _resetForTests } from './rateLimiter.js';
describe('rateLimiter', () => {
  beforeEach(()=> _resetForTests());
  it('allows under limit', () => {
    let nextCalled=false;
    const req={ ip:'1.1.1.1', socket:{} } as any;
    const res={ status:()=> ({ json:()=>{} }) } as any;
    rateLimiter(req,res,()=>{nextCalled=true});
    assert.equal(nextCalled,true);
  });
  it('blocks over limit', () => {
    const req={ ip:'2.2.2.2', socket:{} } as any;
    let blocked=false;
    const res={ status:(code:number)=> ({ json:()=>{ if(code===429) blocked=true; }}) } as any;
    for(let i=0;i<101;i++) rateLimiter(req,res,()=>{});
    assert.equal(blocked,true);
  });
});
