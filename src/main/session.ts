import codecParse from '@gershy/util-codec-parse';
import { Pollen, type PollenInp } from '@gershy/pollen';
import { PollenHttp } from '@gershy/pollen-http';
import { PollenSokt } from '@gershy/pollen-sokt';
import type Logger from '@gershy/logger';
import type { fetch as undiciFetch, Agent as UndiciAgent, WebSocket as UndiciWebSocket } from 'undici';
import type { UndiciUtils } from './pollenPlatformer.ts';

export class PollenPlatformSession extends Pollen<{ http: PollenHttp; sokt: PollenSokt, userId: string, hear: AsyncGenerator<Json> }> {
  
  // If a self-signed cert is provided we need undici implementations to handle it!
  protected cert: null | {
    pub: string,
    undici: {
      fetch:     typeof undiciFetch,
      Agent:     typeof UndiciAgent,
      WebSocket: typeof UndiciWebSocket
    }
  };
  
  constructor(inp: PollenInp<'domain'> & { cert?: { pub: string, undici: UndiciUtils } }) {
    super(inp);
    this.cert = inp.cert ?? null;
  }
  
  protected async sanitizeDef(def: unknown, logger: Logger) {
    
    const { addr, port = null, http: httpInp = null } = codecParse({ type: 'rec', loose: true, props: {
      // TODO: this http-validating codec is duplicated quite a bit...
      addr: { type: 'str', map: v => v as `${string}.${string}` },
      port: { req: false, type: 'num' },
      http: { req: false, type: 'rec', loose: true, props: {
        path: { req: true, type: 'arr', item: { type: 'str' } },
        method: { req: false, type: 'enum', opts: [ 'head', 'get', 'post', 'put', 'patch', 'delete' ] }
      }}
    }} as const, def);
    
    const connect = !this.cert ? null : (() => {
      
      const { fetch: uFetch, Agent, WebSocket } = this.cert.undici;
      
      // An agent, and wrapper fetch+SoktCls values that use the agent as dispatcher
      const agent = new Agent({ connect: { ca: this.cert.pub, rejectUnauthorized: true } });
      const fetch = (url: string, inp: Obj<any>) => uFetch(url, { ...inp, dispatcher: agent });
      const SoktCls = function(url, opts: Obj<any> = {}) {
        return new WebSocket(url, { ...opts, dispatcher: agent });
      } as any as typeof UndiciWebSocket;
      
      logger.log({ $$: 'selfSign' });
      
      return { fetch, SoktCls };
      
    })();
    
    // Define sokt pollen and listen for the initial user id
    const sokt = new PollenSokt({
      
      garden: this.garden,
      flowerId: `domain/${addr}` as const,
      ...(connect ? { SoktCls: connect.SoktCls } : {})
      
    });
    await logger.scope('sokt', {}, logger => sokt.getDef(logger));
    
    // const userId = (await sokt.hear()[cl.find](msg => msg.t === 'id'))?.id ?? null; // TODO: cool potential for `AsyncGenerator.prototype[cl.find]`
    const hear = sokt.hear();
    const userId = await logger.scope('getUserId', {}, async logger => {
      
      while (true) {
        
        const v = await hear.next();
        if (v.done) break;
        
        const msg = v.value as Obj<any>;
        logger.log({ $$: 'notice', msg });
        
        if (msg.t === 'id') return msg.id as string;
        
      }
      
      return null;
      
    });
    logger.log({ $$: 'userId', userId });
    
    if (!userId) throw Error('user id missing');
    
    const http = new PollenHttp({
      garden: this.garden,
      flowerId: `domain/${addr}` as const,
      httpInp: {
        method: 'post',
        ...(connect !== null ? { fetch: connect.fetch } : {}),
        ...(port    !== null ? { port                 } : {}),
        ...(httpInp !== null ? { http: httpInp        } : {}),
        path: [ 'user', userId ] // Include `userId` in all body requests
      } as any
    });
    await logger.scope('http', {}, async logger => http.getDef(logger));
    
    return { http, sokt, userId, hear };
    
  }
  
  public async hear(logger?: Logger) {
    
    // TODO: See SoktPollen.prototype.notice - any sokt-related action initializes the websocket,
    // and once initialized, inbound notices are emitted by this function
    return (await this.getDef(logger)).hear;
    
  }
  
  public async tell<R extends boolean = false>(inp: { logger?: Logger, reply?: R, msg: Json }): Promise<R extends true ? Json : void> {
    
    const { http, sokt, userId } = await this.getDef();
    const { reply = false, msg } = inp;
    
    // If no reply is requested simply send via sokt
    if (!reply) return sokt.fly(msg) as any;
    
    // Otherwise send via http
    const res = await http.fly({ path: [ userId ], body: msg });
    return res.body as any;
    
  }
  
  public async cancel(inp: { logger: Logger }) {
    
    const { sokt } = await this.getDef();
    await sokt.cancel()
    
  }
  
  public async fly(inp: never) { throw Error('script missing'); }
  
  protected getJsfnHoist() { return `${import.meta.filename}::{${this.constructor.name}}` as const; }
  protected getJsfnInp() { return {}; }
  
};
