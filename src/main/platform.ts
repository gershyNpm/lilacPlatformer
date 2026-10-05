import type { Session } from './platformer.ts';
import type Logger from '@gershy/logger';
import type { Jsfn } from '@gershy/util-jsfn-encode';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:net';
import type Stream from 'node:stream';

export type Cert = { '!prv': string, pub: string, expiryMs: number };
export type MainApi = { type: 'ip' | 'dns', certType: 'self' | 'auth', host: string, server: Server, cert?: Cert, setCert: (cert: Cert) => void };
export type State = {
  
  mainApi: null | MainApi,
  
  getSelfSignedCert: (inp: { type: 'ip' | 'dns', host: string, durationMs?: number }) => Promise<Cert>,
  
  // Ip server will use a self-signed cert
  launchMainHttp: (inp: { type: 'ip' | 'dns', host: string, certType: 'self' | 'auth' }) => Promise<MainApi>,
  
};
export type AdminPlatformFnInp<LD, O> = {
  logger: Logger, launchData: LD, state: State, inp: O
};
export type MainFnInp<
  LocalData extends Jsfn,
  LaunchData,
  LaunchFn extends (inp: { debug: boolean, logger: Logger, jsfnImport: (fp: string) => any, localData: LocalData }) => LaunchData,
  InvokeFn extends (inp: { debug: boolean, logger: Logger, jsfnImport: (fp: string) => any, launchData: LaunchData, session: Session, inp: any }) => Promise<void>
> = {
  jsfnImport:    <S extends string>(fp: S) => any, // import(S)
  name:          string,
  debug:         boolean,
  localData:     LocalData,
  launchFn:      LaunchFn,
  invokeFn:      InvokeFn
};
export default { baseUrl: import.meta.url, val: (inp: MainFnInp<any, any, any, any>) => {
  
  // This is the internal platform script
  
  // "tls-addressable fargate setup"
  // 1. The cluster is initialized with an owned public domain name D; every task will be
  //    associated with a subdomain, SD, which looks like `${fargateTaskId}.domain.com`
  // 2. The cluster is also initialized with addressing for an optionally existent full
  //    wildcard letsencrypt cert (private+public keys) for D, i.e. `*.domain.com`, stored
  //    persistently. In dev environment the full cert can also be cached in a temp dir; want
  //    to allow large numbers of test runs without exceeding letsencrypt's conservative
  //    5-certs-per-domain-per-week limiting (although many collaborating devs will need to
  //    watch out and manually share certs). If a cert is found in the dev cache during
  //    deployment, it's uploaded (as part of the deployment) to the s3 bucket.
  //    (should there be a take-for-granted config/secret store created in the main tf proj, which
  //    any system can take advantage of??)
  // 3. Now `terraform apply` has completed, but we are still mid-`Garden.prototype.grow`, at
  //    the output-resolution stage. As part of this stage the cluster will upsert a
  //    letsencrypt certificate, guaranteeing that post-grow, there is a cert to support
  //    fargate tasks.
  // 4. The nodejs process owns deployment; there are no race conditions here. The cluster
  //    will now guarantee a letsencrypt certificate exists before `Garden.prototype.grow`
  //    returns. Step 1: query the s3 bucket; maybe there is pre-existing infra (i.e. this
  //    isn't the first time this garden has been grown). If the bucket has a cert with good
  //    longevity we are good-to-go - cert confirmed! Otherwise, step 2: check dev
  //    environment cache for an existing wildcard cert with longevity for D - if one exists
  //    upload it to s3 - cert confirmed! Otherwise, step 3: create a fargate task and as
  //    usual wait for its ip to resolve and its admin endpoint to become active. This
  //    fargate task runs `certbot`, i.e.:
  //        | 
  //        | # note `sudo snap` requires a specific os; need to make sure package manager
  //        | # is available in the docker container
  //        | > sudo snap install --classic certbot
  //        | > sudo snap set certbot trust-plugin-with-root=ok
  //        | > sudo snap install certbot-dns-route53
  //        | > certbot certonly \
  //        |     --dns-route53 \
  //        |     --non-interactive \
  //        |     --agree-tos \
  //        |     --email your-email@mydomain.com \
  //        |     -d "mydomain.com" \
  //        |     -d "*.mydomain.com"
  //        | 
  //    and returns the letsencrypt payload, which is then set in s3 - cert confirmed! The
  //    fargate task used for this purpose is killed (its purpose was only to run `certbot`)
  // 5. Now `Garden.prototype.grow` returns; the cluster is fully deployed with an available
  //    letsencrypt cert stored in s3.
  // 6. Task creation is requested from the cluster; it uses RunTask (with LILAC_ADMIN_PASS),
  //    and waits for ip addressability and "/admin" responsiveness. Now the cluster creates
  //    a route53 record pointing `${fargateTaskId}.domain.com` to the task's public ip - now
  //    the task can be referenced by its subdomain, with letsencrypt serving as the trusted
  //    authority for TLS connections!
  // 7. Once the dns record is created, the cluster uses the /admin endpoint to set the task
  //    up for public access with arbitrary consumer functionality: (1) informs the task of
  //    its own ip address, (2) informs the task of its *.domain.com hostname, (3) provides
  //    the task the full letsencrypt private+public key, so the task can terminate TLS, and
  //    (4) tears down the admin server, replacing it with a public port-443 https server
  //    configured with the letsencrypt cert
  // 8. ServerCluster *without* an owned domain name: uses a self-signed certificate; the
  //    pollen client is populated with the public key, and uses:
  //        | 
  //        | const agent = new Agent({ connect: { ca: trustedCert } });
  //        | await fetch('https://54.210.43', { dispatcher: agent });
  //        | 
  // 
  // - We manage a letesncrypt cert for every cluster, and a dns record for every task
  // - Letsencrypt certs expire - how can long-running tasks renew their cert?
  // - Tasks can die for any reason - how to clean up their associated dns records?
  // - Blast radius: if somehow any task reveals its private key, all tasks are compromised
  // - `require('https').createServer(...).setSecureContext(...)` can be used to seamlessly
  //   refresh tls cert
  
  const { default: Logger }                 = inp.jsfnImport('@gershy/logger') as typeof import('@gershy/logger');
  const { createServer: createServerHttp }  = inp.jsfnImport('node:http')      as typeof import('node:http');
  const { createServer: createServerHttps } = inp.jsfnImport('node:https')     as typeof import('node:https');
  const { WebSocketServer }                 = inp.jsfnImport('ws')             as typeof import('ws');
  const { generate: generateSelfSignCert }  = inp.jsfnImport('selfsigned')     as typeof import('selfsigned');
  
  const { jsfnImport, name, debug, localData, launchFn, invokeFn } = inp;
  
  const logger = new Logger('server', {}, { maxStrLen: 500 }, inp => console.log(JSON.stringify(inp)));
  
  // Monitor for inactivity and shut down accordingly
  const topLevelKeepAlive = (() => {
    
    let timeout: null | NodeJS.Timeout;
    const reset = () => {
      clearTimeout(timeout as any);
      timeout = setTimeout(() => {
        logger.log({ $$: 'inactivity' });
        setTimeout(() => process.exit(0), 1000);
      }, 1000 * 60 * 5); // 5min - sufficient?
    };
    reset();
    
    return reset;
    
  })();
  
  type RunServerInp = {
    maxHeaderSize?: number,
    headersTimeout?: number,
    requestTimeout?: number,
    type: 'http' | 'https',
    logger: Logger,
    fn: (inp: { method: string, path: `/${string}`, query: `?${string}`, fragment: `#${string}`, body: Json, req: IncomingMessage, res: ServerResponse }) => Promise<{ code: number | 'kill' | 'ignore', body: Json }>
  };
  const runServer = async (inp: RunServerInp) => {
    
    const {
      maxHeaderSize = 3000,
      headersTimeout = 3 * 1000,
      requestTimeout = 5 * 1000,
      type,
      logger,
      fn
    } = inp;
    
    const createServer = ({ http: createServerHttp, https: createServerHttps })[type] as typeof createServerHttps;
    const server = createServer({ maxHeaderSize, headersTimeout, requestTimeout });
    const sokts = new Set<Stream.Duplex>();
    server.on('connection', sokt => {
      sokts.add(sokt);
      sokt.once('close', () => sokts[cl.rem](sokt));
    });
    server.on('request', async (req, res) => logger.scope('invoke', { addr: req.socket.address() }, async () => {
      
      const method = (req.method ?? 'get')[cl.lower]();
      const [ , path='/', query='?', fragment='#' ] = ((req.url ?? '/').match(/^([/][^?#]*)([?][^#]*)?([#].*)?$/) ?? []) as [ unknown, `/${string}`, `?${string}`, `#${string}` ];
      
      const { code, body } = await cl.safe(async () => {
        
        const reqBodyRaw = await new Promise<string>((rsv, rjc) => {
          
          let len = 0;
          const chunks: Buffer[] = [];
          const timeout = setTimeout(() => end(Error('reject')[cl.mod]({ http: { code: 400, body: { msg: 'body sluggish' } } })), 5000);
          
          const end = (err: null | any) => {
            req.off('data', onData);
            req.off('end', end);
            if (!err) { rsv(Buffer.concat(chunks).toString('utf8')); }
            else      { rjc(err); req.socket.destroy(); }
            clearTimeout(timeout);
          };
          
          const onData = chunk => {
            if ((len += chunk.length) > (2 ** 15)) end(Error('reject')[cl.mod]({ http: { code: 400, body: { msg: 'body oversized' } } }));
            chunks.push(chunk);
          };
          const onEnd = () => end(null);
          req.on('data', onData);
          req.on('end', onEnd);
          
        });
        const reqBody = cl.safe(() => JSON.parse(reqBodyRaw || 'null') as Json, () => {
          throw Error('reject')[cl.mod]({ http: { code: 400, body: { msg: 'body json invalid', body: reqBodyRaw } } })
        });
        logger.log({ $$: 'parsed', path, method, query, fragment, body: reqBody });
        
        return await fn({ path, method, fragment, query, body: reqBody, req, res });
        
      }, err => {
        
        const { code, body } = (err.http ?? { code: 500, body: { msg: 'unexpected error' } }) as { code: number, body: Json };
        logger.log({ $$: code >= 500 ? 'glitch' : 'reject', err });
        return { code, body };
        
      });
      
      if (code === 'ignore') return;
      
      if (code === 'kill') {
        req.socket.destroy();
        res.socket?.destroy();
        return;
      }
      
      const jsonBody = JSON.stringify(body);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonBody).toString(10)
      });
      res.end(jsonBody);
      
    }));
    server.listen({ http: 80, https: 443 }[inp.type], '0.0.0.0');
    
    await new Promise(rsv => server.once('listening', rsv));
    
    return Object.assign(server, { rake: () => {
      
      server.removeAllListeners('request');
      server.removeAllListeners('connection');
      server.on('request',    req  => req.socket.destroy());
      server.on('connection', sokt => sokt.destroy());
      for (const sokt of sokts) sokt.destroy();
      sokts.clear();
      
      return new Promise(rsv => server.close(rsv));
      
    }});
    
  };
  
  logger.scope(null, { name }, async logger => {
    
    const state: State = {
      
      mainApi: null,
      
      getSelfSignedCert: async inp => {
        
        const { type, host, durationMs = 1000 * 60 * 60 * 24 * 7 } = inp;
        
        const now = Date.now();
        const expiryMs = now + durationMs;
        
        const genCertInp: any = [
          [{ name: 'commonName', value: host }], {
            keySize: 4096,
            algorithm: 'sha256',
            notBeforeDate: new Date(now),
            notAfterDate:  new Date(expiryMs),
            extensions: [{
              name: 'subjectAltName',
              altNames: [ { ip: { type: 7, ip: host }, dns: { type: 2, value: host } }[type] ]
            }]
          }
        ];
        
        const pems = await generateSelfSignCert(...genCertInp);
        return { '!prv': pems.private, pub: pems.cert, expiryMs };
        
      },
      
      launchMainHttp: async inp => {
        
        const sessions = new Map<Session['id'], Session>()
        
        const server = await runServer({
          logger: logger.kid('https'),
          type: 'https',
          fn: async inp => {
            
            if (inp.path === '/ping') return { code: 200, body: { msg: 'pong' } };
            
            const userId = inp.path.split('/').at(-1)!; // Ignore all but last component?
            const user = sessions.get(userId);
            if (!user) return { code: 400, body: { msg: 'bad request' } };
            
            topLevelKeepAlive();
            return { code: 200, body: await invokeFn({ debug, logger, launchData, jsfnImport, user, inp: inp.body }) };
            
          }
        });
        const soktServer = new WebSocketServer({ server });
        
        soktServer.on('connection', sokt => {
          
          const session: Session = {
            id: Math.random().toString(36).slice(2),
            sokt,
            send: (inp: Json) => new Promise((rsv, rjc) => sokt.send(JSON.stringify(inp), err => err ? rjc(err) : rsv()))
          };
          
          sessions.set(session.id, session);
          session.send({ t: 'id', id: session.id });
          
          sokt.on('message', async inp => {
            
            topLevelKeepAlive();
            if (cl.isCls(inp, Array)) inp = Buffer.concat(inp);
            if (cl.isCls(inp, ArrayBuffer)) inp = Buffer.from(new Uint8Array(inp));
            await invokeFn({ debug, logger, launchData, jsfnImport, user: session, inp: JSON.parse(inp) });
            
          });
          sokt.on('close', () => sessions.delete(session.id));
          
        });
        
        const api = state.mainApi = {
          type: inp.type,
          certType: inp.certType,
          host: inp.host,
          server,
          setCert: cert => {
            server.setSecureContext({ key: cert['!prv'], cert: cert.pub });
            (api as any).cert = cert;
          }
        };
        
        if (inp.certType === 'self') {
          
          const durationMs = 1000 * 60 * 60 * 24 * 7;
          const renewSelfSignedCert = async () => api.setCert(await state.getSelfSignedCert({ ...inp, durationMs }));
          
          await renewSelfSignedCert();
          setInterval(() => renewSelfSignedCert(), durationMs * 0.9);
          
        }
        
        return api;
        
      }
      
    };
    const adminPass = process.env.gershyLilacAdminPass;
    
    const launchData = await logger.scope('launchData', {}, async logger => launchFn?.({ debug, logger, jsfnImport, localData }));
    
    const adminServer = await runServer({ logger: logger.kid('admin'), type: 'http', fn: async ({ path, body, req, res }) => {
      
      if (path === `/admin/${adminPass}`) {
        
        topLevelKeepAlive();
        
        const msg = await (async () => {
          
          const { fn: fnStr, ...inp } = body as any;
          const fn = eval(fnStr || 'inp => null') as (inp: AdminPlatformFnInp<any, any>) => Json;
          const out: Json = (await fn({ logger, launchData, state, inp })) ?? null;
          return { success: true, out };
          
        })().catch(err => ({
          
          success: false,
          err: err?.[cl.limn]?.() ?? err?.toString() ?? '<unknown>'
          
        }));
        
        return { code: 200, body: msg };
        
      }
      
      throw Error('reject')[cl.mod]({ http: { code: 404, body: { msg: 'missing' } } });
      
    }});
    
    // TODO: `server.on('error', ...)`
    await new Promise(rsv => adminServer.once('listening', rsv));
    logger.log({ $$: 'serverActive', proto: 'http', port: 80 });
    
    // TODO: hook `invokeFn` up to mainApi websocket events
    return (inp: any) => invokeFn({ debug, logger, launchData, jsfnImport, inp });
    
  });
  
}};
