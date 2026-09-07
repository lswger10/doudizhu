import { normalizeAdapterResponse } from './doudizhu-adapters.js';

export class GatewayPlayerAdapter {
  constructor(url, token) { this.url=url; this.token=token; this.pending=new Set(); }
  cancel() { for (const c of this.pending) c.abort(); }
  async decide(player, payload, {timeoutMs=50000}={}) {
    if (!this.isConnected?.()) throw new Error("牌桌已断开");
    const actor={aevi:'jiao',vex:'laoke'}[player.id];
    if (!actor) throw new Error('这个座位只支持本地策略');
    const controller=new AbortController(); this.pending.add(controller);
    const timer=setTimeout(()=>controller.abort(), Math.min(timeoutMs,50000));
    try {
      const r=await fetch(this.url+'/internal/doudizhu/decide', {method:'POST',
        headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},
        body:JSON.stringify({actor_id:actor,payload}),signal:controller.signal});
      if (!r.ok) throw new Error('模型暂不可用');
      return normalizeAdapterResponse(await r.json());
    } finally {clearTimeout(timer);this.pending.delete(controller);}
  }
}
