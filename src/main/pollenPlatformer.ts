import { DescribeNetworkInterfacesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeClustersCommand, DescribeTasksCommand, ECSClient, ListTagsForResourceCommand, ListTasksCommand, RunTaskCommand, StopTaskCommand, TagResourceCommand } from '@aws-sdk/client-ecs';
import { ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand, GetChangeCommand, ListHostedZonesByNameCommand, Route53Client as R53Client, RRType } from '@aws-sdk/client-route-53';
import codecParse from '@gershy/util-codec-parse';
import { Pollen, type PollenInp, type Scheme } from '@gershy/pollen';
import { PollenHttp } from '@gershy/pollen-http';
import { regions as awsRegions, httpPools, Soil, NodeHttpHandler} from '@gershy/lilac';
import retry from '@gershy/util-retry';
import paging from '@gershy/util-paging';
import Logger from '@gershy/logger';
import { crypto as acmeCrypto, Client as AcmeClient, directory as acmeDirectory } from 'acme-client';
import { PollenSokt } from '@gershy/pollen-sokt';
import { fetch as undiciFetch, Agent as UndiciAgent, WebSocket as UndiciWebSocket } from 'undici';
import type { AdminPlatformFnInp, Cert } from './platform.ts';
import type { Fact } from '@gershy/disk';

// TODO: "host" vs "domain" vs "address"
// "host" - network-recognized machine name (e.g. domain name, ip address)
// "domain" - dns-recognized name/ip mapping
// "address" - ???

const { funnel } = (() => {
  
  // TODO: @gershy/iac-lifecycle (or can it be more generic than iac? but it will involve permissions...)
  abstract class AbstractIac {
    
    // Can handle creation, deletion, discovery and permissions...
    
    public abstract resolve(): Promise<any>;
    
  };
  class IacFn<T> extends AbstractIac {
    
    protected resolver: () => Promise<T>;
    constructor(resolver: () => Promise<T>) {
      super();
      this.resolver = resolver;
    }
    
    public resolve() { return this.resolver(); }
    
  };
  class IacObj<O extends Obj<{ resolve: () => Promise<any> }>> extends AbstractIac {
    
    protected resolvers: O;
    constructor(resolvers: O) {
      super();
      this.resolvers = resolvers;
    }
    
    public resolve() {
      return Promise[cl.allObj](this.resolvers[cl.map](r => r.resolve())) as Promise<{ [K in keyof O]: Awaited<ReturnType<O[K]['resolve']>> }>;
    }
    
  };
  class IacArr<T> extends AbstractIac {
    
    protected resolver: () => AsyncGenerator<T>
    constructor(resolver: () => AsyncGenerator<T>) {
      super();
      this.resolver = resolver;
    }
    
    public resolve() {
      return this.resolver()[cl.toArr](v => v);
    }
    
  };
  const platformerIac = new IacObj({
    
    acmeR53Txt: new IacFn(async () => {
      
      // List all dns records in search of the acme challenge record
      
    })
    
  });
  void [ IacArr, platformerIac ];
  
  const funnel = async function*<T>(gens: AsyncGenerator<T>[]): AsyncGenerator<T> {
    
    // TODO: move to @gershy/util-funnel
    
    const streams = new Set(gens.map(gen => {
      
      const stream = {
        pending: gen.next(),
        next: () => stream.pending = gen.next(),
      };
      return stream;
      
    }));
    
    while (streams.size) {
      
      const { stream, itr } = await Promise.race(
        [ ...streams ]
          .map(stream => stream.pending.then(itr => ({ stream, itr })))
      );
      if (itr.done) { streams.delete(stream); continue; }
      
      stream.next();
      yield itr.value;
      
    }
    
  };
  
  return { funnel };
  
})();

export type TaskStatus = 'provisioning' | 'pending' | 'activating' | 'running' | 'deactivating' | 'stopping' | 'deprovisioning' | 'stopped' | 'deleted';
export type Task = {
  id: string,
  utcMs: number,
  tags: Obj<string>,
  status: TaskStatus,
  stopped: null | { utcMs: number, reason: string },
  eni: null | { id: string }
};
export type Platform = {
  task: Task,
  '!adminPass': string,
  ipHost: string,
  dnsHost: null | string
};
export type PollenPlatformerDef = Omit<Scheme['awsFargate'], 'cluster'> & {
  ec2Client: EC2Client,
  ecsClient: ECSClient,
  r53Client: R53Client,
  cluster: { id: string, name: string },
  hostedZoneId: null | string
};
export type PollenPlatformerInp = PollenInp<`awsFargate/${string}`> & {
  dns?: {
    configFact: Fact,
    rootHost: `${string}.${string}`,
    letsEncrypt: { accountPrivateKey?: string, directory: 'm1' | 'm2', email: string }
  },
  stockEc2Client?: EC2Client,
  stockEcsClient?: ECSClient,
  stockR53Client?: R53Client,
  stockHostedZoneId?: string
};
export class PollenPlatformer extends Pollen<PollenPlatformerDef> {
  
  // The current model is that kid platforms never call home to their par platformer. Could
  // consider allowing kid->par communication - this would save the par from management in terms of
  // exhaustive sweeps. E.g. instead of par needing to visit every kid to ensure letsEncrypt cert
  // freshness, could have kids actively request fresh certs from the par when their certs become
  // stale. The nice thing about the strict par->kid model we currently have is it nicely supports
  // a local unaddressable environment managing the entire cluster. If kids needed to address the
  // local environment we'd need some kind of static address for local, which gets messy...
  
  protected dns: null | {
    configFact: Fact,
    rootHost: `${string}.${string}`,
    letsEncrypt: { accountPrivateKey?: string, directory: 'm1' | 'm2', email: string },
    certPrm: null | Promise<Cert> | Cert
  };
  protected stockEc2Client:    null | EC2Client;
  protected stockEcsClient:    null | ECSClient;
  protected stockR53Client:    null | R53Client;
  protected stockHostedZoneId: null | string;
  constructor(inp: PollenPlatformerInp) {
    
    super(inp);
    
    this.dns = inp.dns ? { ...inp.dns, certPrm: null } : null;
    
    if (this.dns) Error[cl.assert](this.dns, inp => /^[a-z0-9-]+(?:[.][a-z0-9-]+)+$/.test(inp.rootHost));
    
    this.stockEc2Client = inp.stockEc2Client ?? null;
    this.stockEcsClient = inp.stockEcsClient ?? null;
    this.stockR53Client = inp.stockR53Client ?? null;
    this.stockHostedZoneId = inp.stockHostedZoneId ?? null; // TODO: consume
    
    // script / domain / member
    
    // Pollen member must:
    // - sync tasks with their dns entries
    // - scan for orphaned dns entries periodically
    // - maintain wildcard cert
    // - update task wildcard certs periodically
    
  }
  
  protected getJsfnHoist() { return `${import.meta.filename}::{${this.constructor.name}}` as const; }
  protected getJsfnInp() { return {
    
    // TODO: should include `this.dns` but `this.dns.configFact` isn't serializable...
    ...(this.stockHostedZoneId ? { stockHostedZoneId: this.stockHostedZoneId } : {})
    
  }; }
  
  protected async sanitizeDef(def: unknown, logger: Logger) {
    
    // Pollen protocol; initialize all clients and discover all values needed for this Pollen
    
    const info = codecParse({ type: 'rec', loose: true, props: {
      region: { type: 'enum', opts: awsRegions.map(r => r.term) },
      cluster: { type: 'str' },
      family: { type: 'str' },
      subnetIds: { type: 'arr', item: { type: 'str' } },
      securityGroupId: { type: 'str' }
    }} as const, def);
    
    const getClient = async <S extends { config?: { region?: any } }>(args: { stock: null | S, Ctor: { new (cfg: Soil.AwsClientConfig & { requestHandler: NodeHttpHandler }): S } }): Promise<S> => {
      
      const { stock, Ctor } = args;
      if (stock) {
          const reg0 = stock.config?.region;
          const reg = (cl.inCls(reg0, Function) ? await reg0() : reg0);
          if (info.region === reg) return stock;
      }
      
      // Performance characteristics:
      // - ec2: needed to resolve network interface for fargate tasks; used whenever resolving a platform
      // - ecs: used all over the place; runs, tags, lists, and stops tasks; used probably several times in every operation including orphan sweep
      // - r53: read the hosted zone at Platformer startup, maintain dns records parallel to tasks, heavily involved in orphan cleanup
      return new Ctor({
        ...(this.garden.defaults.awsClientConfig ?? {}),
        region: info.region,
        requestHandler: httpPools.size2
      });
      
    };
    
    const [ ec2Client, ecsClient, r53Client ] = await Promise.all([
      getClient<EC2Client>({ stock: this.stockEc2Client, Ctor: EC2Client }),
      getClient<ECSClient>({ stock: this.stockEcsClient, Ctor: ECSClient }),
      getClient<R53Client>({ stock: this.stockR53Client, Ctor: R53Client })
    ]);
    
    const [ hostedZoneId, clusterId ] = await Promise.all([
      
      // Find hosted zone id by name
      (async () => {
        
        if (!this.dns) return null;
        
        if (this.stockHostedZoneId) return this.stockHostedZoneId;
        
        const { rootHost } = this.dns;
        const hostedZoneName = `${rootHost}.`;
        const zone = await paging(async last => {
          
          const res = await r53Client.send(new ListHostedZonesByNameCommand({
            DNSName: hostedZoneName,
            MaxItems: 100,
            ...(last && { HostedZoneId: last })
          }));
          return { page: res.HostedZones ?? [], next: res.NextHostedZoneId ?? null };
          
        })[cl.find](zone => zone.Name === hostedZoneName);
        if (!zone?.Id) throw Error('hosted zone missing')[cl.mod]({ rootHost, hostedZoneName, zone });
        
        return zone.Id;
        
      })(),
      
      // Get cluster id from cluster name
      (async () => {
        
        const { clusters } = await ecsClient.send(new DescribeClustersCommand({
          clusters: [ info.cluster ]
        }));
        const clusterId = clusters?.[0]?.clusterArn ?? null;
        if (!clusterId) throw Error('ecs cluster missing')[cl.mod](info[cl.slice]([ 'region', 'cluster' ]));
        
        return clusterId;
        
      })()
      
    ]);
    
    return {
      ...info,
      ec2Client,
      ecsClient,
      r53Client,
      hostedZoneId,
      cluster: {
        id: clusterId,
        name: info.cluster
      }
    };
    
  }
  
  protected async orphanSweep(inp: { logger: Logger, ignoreRecent?: boolean }) {
    
    // End-of-day cleanup; performs a single sweep for orphaned resources:
    // - Dns records that have no corresponding ecs task
    
    const dns = this.dns;
    if (!dns) throw Error('dns missing');
    
    const { logger, ignoreRecent = true } = inp;
    const { hostedZoneId, r53Client, ecsClient, cluster } = await this.getDef(logger);
    const { rootHost } = dns;
    
    await logger.scope('orphanSweep', {}, async logger => {
      
      type DnsRecord = (typeof dnsRecords) extends AsyncGenerator<infer T> ? T : never;
      const dnsRecords = paging(async last => {
        
        const res = await r53Client.send(new ListResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId!,
          ...(last && {
            StartRecordName: last.NextRecordName,
            StartRecordType: last.NextRecordType,
            StartRecordIdentifier: last.NextRecordIdentifier,
          })
        }));
        
        return {
          page: (res.ResourceRecordSets ?? []).map(v => ({
            
            type: v.Type![cl.lower](),
            key: v.Name ?? '<unknown>',
            val: v.ResourceRecords?.[0]?.Value ?? null,
            ttl: v.TTL!
            
          })),
          next: res[cl.slice]([ 'NextRecordName', 'NextRecordType', 'NextRecordIdentifier' ])
        };
        
      });
      
      const counts = { total: 0, rem: 0 };
      const recHandlers = {
        
        txt: async rec => {
          
          // 'txt' records relate to acme challenge completion; they can be orphaned due to the
          // acme process being unexpectedly interrupted in an earlier execution; if we encounter
          // the acme record after the acme cert has already been obtained we destroy it; as the
          // orphan sweep loop initializes before the acme cert we need to avoid destroying the
          // cert during the window in which the acme process is relying on it!
          
          if (!cl.isCls(this.dns!.certPrm, Object))      return; // Acme challenge is still active - don't interfere
          if (rec.key !== `_acme-challenge.${rootHost}`) return; // Ensure it's the acme challenge record
          if (!rec.val)                                  return; // The acme challenge record should have a value
          
          await logger.scope('dnsRem', { rec }, () => this.dnsMod({ logger, op: 'rem', ...rec }));
          counts.rem++;
          
        },
        a: async rec => {
          
          // 'a' records are the per-task ip-to-domain entries; they should be cleaned up if
          // orphaned, i.e. no corresponding fargate task
          
          if (!rec.key[cl.hasTail](`.${rootHost}`)) return;
          if (!rec.val)                             return;
          
          // Now `rec` maps dns->ip and we need to remove it if its task no longer exists
          const taskId = rec.key.split('.')[0];
          const taskRes = await ecsClient.send(new DescribeTasksCommand({ cluster: cluster.name, tasks: [ taskId ] }));
          const task = taskRes.tasks?.[0];
          
          // Apply recency preservation if requested, for young tasks (5min)
          if (ignoreRecent && task && (+task.createdAt! > (Date.now() - 1000 * 60 * 5))) return;
          
          // Preserve dns for tasks which look active; note fargate tasks may immediately become
          // dns-inaccessible as soon as their desired status becomes "stopping" (even though the
          // script within the task may still be running in that time) - this is desired behaviour!
          if (task && task.desiredStatus?.[cl.lower]() === 'running') return;
          
          // No healthy corresponding task found - `rec` is an orphan, clean it up!
          await logger.scope('dnsRem', { rec }, () => this.dnsMod({ logger, op: 'rem', ...rec }));
          counts.rem++;
          
        }
        
      } as const satisfies { [K in Lowercase<RRType>]?: (rec: DnsRecord) => Promise<void> };
      for await (const rec of dnsRecords) {
        await recHandlers[cl.at](rec.type, async () => {})(rec)
          .catch(err => logger.log({ $$: 'glitch', err }));
        counts.total++;
      }
      
      logger.log({ $$: 'result', counts });
      
    });
    
  }
  
  protected async renewCertSweep(inp: { logger: Logger, delayMs?: number }) {
    
    // Sweeps all existing tasks and checks the cert freshness of each; `delayMs` applies between
    // every processed task
    
    const { dns } = this;
    if (!dns) throw Error('dns missing');
    
    const { cluster, ecsClient } = await this.getDef();
    const { logger, delayMs = null } = inp;
    
    await logger.scope('renewCertSweep', {}, async logger => {
      
      const counts = { total: 0, renewed: 0 };
      
      const pageTaskIds = paging<string, string>(last => ecsClient.send(new ListTasksCommand({
        cluster: cluster.name,
        ...(last ? { nextToken: last } : {})
      })).then(v => ({ next: v.nextToken ?? null, page: v.taskArns ?? [] })));
      
      for await (const taskId of pageTaskIds) {
        
        // TODO: overkill here e.g. `this.taskToPlatform` polls/retries; we don't need that here
        
        // If anything is invalid about a task we can skip it - we have plenty of time to get back to
        // it; the vast majority of issues we could encounter here are related to task readiness and
        // these naturally resolve with time
        
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        
        const { tasks: [ awsTask = null ] = [] } = await ecsClient.send(new DescribeTasksCommand({
          cluster: cluster.name,
          tasks: [ taskId ],
          include: [ 'tags'[cl.upper]() ]
        }));
        if (!awsTask) continue;
        
        const task = this.makeTask(awsTask);
        const platform = await this.taskToPlatform({ logger, task, requireLilacActive: true });
        const adminApi = await this.platformAdminPollenGet(platform);
        
        const expiryMs = await adminApi.fly({}, o => o.state.mainApi?.cert?.expiryMs ?? null);
        if (!expiryMs) continue; // No expiry ms is a failure mode; ignore!
        counts.total++;
        
        // If the cert has longevity, ignore it!
        if (this.isCertFresh({ expiryMs })) continue;
        
        // Update the task's cert...
        const cert = await this.getLetsEncryptCert({ logger });
        await adminApi.fly({ cert }, o => o.state.mainApi?.setCert(o.inp.cert));
        counts.renewed++;
        
      }
      
      logger.log({ $$: 'result', counts });
      
    });
    
  }
  
  protected isCertFresh(inp: { expiryMs: number }) { return inp.expiryMs > (Date.now() + 1000 * 60 * 60 * 24 * 2); } // Cert is simply fresh if it has at least 2 more days of longevity
  
  protected async dnsMod(inp: { logger, op: 'set' | 'rem', type: Lowercase<RRType>, key: string, val: null | string, ttl?: number }) {
    
    const { hostedZoneId, r53Client } = await this.getDef(inp.logger);
    
    Error[cl.assert](hostedZoneId, () => !!hostedZoneId);
    
    const { op, type, key, val, ttl = 60 } = inp;
    return inp.logger.scope('dns', { op, type, key, val }, async logger => {
      
      const change = await r53Client.send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId!, // If `this.dns` is set, `this.sanitizeDef` must have returned an extant `hostedZoneId`
        ChangeBatch: { Changes: [{
          Action: ({ set: 'upsert', rem: 'delete' } as const)[op][cl.upper](),
          ResourceRecordSet: {
            Name: key,
            Type: type[cl.upper](),
            TTL: ttl,
            ResourceRecords: val ? [{ Value: val }] : []
          }
        }]}
      })).catch(err => {
        if (/was not found/.test(err.message)) return null;
        throw err;
      });
      
      const changeId = (() => {
        
        if (change === null && op === 'rem') return null;
        if (!change)                         throw Error('change missing');
        
        const changeId = change.ChangeInfo?.Id ?? null;
        if (!changeId) throw Error('route53 change missing')[cl.mod]({ type, key, val, ttl, change });
        return changeId;
        
      })();
      logger.log({ $$: 'changeLaunch' });
      
      if (changeId) await retry({ maxDelayMs: 60 * 1000, delayMs: n => Math.min(5000, n * 250), fn: async () => {
        
        const change = await r53Client.send(new GetChangeCommand({ Id: changeId }));
        if (change.ChangeInfo?.Status !== 'insync'[cl.upper]()) throw Error('route53 change pending')[cl.mod]({ type, key, val, ttl, changeInfo: change.ChangeInfo, retry: true });
        
      }});
      logger.log({ $$: 'changeAccept', type, key, val, ttl });
      
    });
    
  }
  
  protected makeTask(awsTask: {
    
    taskArn?: string,
    tags?: { key?: string, value?: string }[],
    lastStatus?: string,
    stoppedAt?: Date,
    stoppedReason?: string,
    createdAt?: Date,
    attachments?: { type?: string, details?: { name?: string, value?: string }[] }[]
    
  }): Task {
    
    const eniId = awsTask.attachments
      ?.find(attachment => attachment.type === 'ElasticNetworkInterface')
      ?.details
      ?.find(detail => detail.name === 'networkInterfaceId')
      ?.value
      ?? null;
    
    return {
      
      id: awsTask.taskArn!,
      utcMs: awsTask.createdAt!.getTime(),
      tags: (awsTask.tags ?? [])[cl.toObj](tag => [ tag.key!, tag.value! ] as const),
      status: awsTask.lastStatus![cl.lower]() as TaskStatus,
      stopped: !awsTask.stoppedAt ? null : {
        utcMs: awsTask.stoppedAt.getTime(),
        reason: awsTask.stoppedReason ?? 'unknown'
      },
      eni: eniId ? { id: eniId } : null
      
    };
    
  }
  
  protected async taskToPlatform(inp: { logger: Logger, task: Task, requireLilacActive?: boolean }): Promise<Platform> {
    
    // Get a task by id:
    // - ecs is eventually consistent; existing tasks may not immediately show in DescribeTasks
    // - stopping/stopped tasks are rejected
    // - if configured, retries until gershy-lilac-initialization
    // - retries until the task has an existing network interface id
    // 
    // The process:
    // 1. Poll "describe task" until a task is returned
    //    - Extra criteria: if `requireLilacActive` is set we poll until the task is additionally
    //      tagged as lilac-active
    // 2. Poll "describe network interfaces" until we obtain the task's public ip
    
    const { ecsClient, ec2Client, cluster } = await this.getDef();
    const { logger, requireLilacActive = true } = inp ?? {};
    
    const task: Task = {}[cl.merge](inp.task) as any;
    
    const getState = (task: Task): 'queued' | 'accept' | 'glitch' => {
      if (task.stopped)                                                             return 'glitch';
      if (requireLilacActive && task.tags[cl.at]('gershyLilacStatus') !== 'active') return 'queued';
      if (!task.eni)                                                                return 'queued';
      return 'accept';
    };
    
    // Wait for `task` to be ready, if required...
    if (getState(task) !== 'accept') await retry({ maxDelayMs: 90 * 1000, delayMs: n => Math.max(n * 250, 1500), fn: async () => {
      
      const { tasks: [ awsTask = null ] = [], failures = [] } = await ecsClient.send(new DescribeTasksCommand({
        cluster: cluster.name,
        tasks: [ task.id ],
        include: [ 'tags'[cl.upper]() ]
      }));
      if (!awsTask) throw Error('task missing')[cl.mod]({ taskId: task.id, failures, retry: true });
      
      Object.assign(task, this.makeTask(awsTask));
      if (task.stopped) throw Error('task stopped')[cl.mod]({ task });
      
      const state = getState(task);
      if (state === 'accept') return;
      
      throw Error(`task ${state}`)[cl.mod]({ requireLilacActive, task, retry: state === 'queued' });
      
    }});
    logger.log({ $$: 'task', task });
    
    // Get the public ip
    // - eventually consistent; need to retry
    const { val: publicIp } = await retry({ maxDelayMs: 1000 * 60 * 3, delayMs: n => Math.max(1500, n * 250), fn: async () => {
      
      const eni = await ec2Client.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [ task.eni!.id ] })).catch(err => {
        if (err.Code === 'InvalidNetworkInterfaceID.NotFound') throw Error('eni missing')[cl.mod]({ task, retry: true }); // TODO: we're inferring the task is stopped because its eni isn't found... is that safe?
        throw err;
      });
      const publicIp = eni.NetworkInterfaces?.[0]?.Association?.PublicIp ?? null;
      if (!publicIp) throw Error('public ip missing')[cl.mod]({ task, eni, retry: true });
      return publicIp;
      
    }}).catch(cause => {
      
      // TODO: safe to assume eni discovery failure after retries indicates task nonexistence?
      throw Error('task stopped')[cl.mod]({ cause });
      
    });
    
    return {
      task,
      '!adminPass': task.tags.gershyLilacAdminPass,
      ipHost: publicIp,
      dnsHost: task.tags[cl.at]('gershyLilacDnsHost', null)
    };
    
  }
  
  protected platformAdminPollenGet(platform: Platform) {
    
    // A pollen to interact with the fargate admin api which executes arbitrary code
    // Simply uses a PollenHttp, with a thin wrapper that applies arbitrary-execution typing
    
    // TODO SEC: mitm can see plaintext adminPass!!!!!!! Need to encrypt I think...
    const pollenHttp = new PollenHttp({
      garden: { serviceMap: {}, defaults: {} },
      flowerId: `domain/${platform.ipHost as `${string}.${string}.${string}.${string}`}` as const,
      httpInp: {
        netProc: { proto: 'http', port: 80 },
        path: [ 'admin', platform['!adminPass'] ],
        method: 'post',
        body: {}
      }
    });
    
    const fly =  async <
      O extends { [K: string]: any },
      Fn extends (inp: AdminPlatformFnInp<any, O>) => Promise<void | Json> | void | Json
    >(obj: O, fn: Fn): Promise<Awaited<ReturnType<Fn>>> => {
      
      const { body } = await pollenHttp.fly<{ success: true, out: Json } | { success: false, err: any }>({
        body: { ...obj, fn: fn.toString() }
      });
      
      // Identity comparison with `true` full validates platform admin api response
      // Note `body.err.trace` is the stack trace from within the fargate bundle! Mapping it back
      // would be cool but a fair bit of effort...
      if (body.success !== true) throw Error(body.err.msg)[cl.mod]({  ...(body.err[cl.slash]([ 'form', 'cause', 'msg', 'trace' ])) });
      
      return body.out as any;
      
    };
    
    return { fly };
    
  }
  
  protected async getLetsEncryptCert(inp: { logger: Logger }): Promise<Cert> {
    
    // Careful keeping this method race-condition free. Anticipate many callers calling this method
    // in parallel! It's a bit tricky because:
    // - We want both an in-memory and on-disk (`configFact`) cache
    // - We want to resolve `this.dns.certPrm` to the actual non-promise cert when it's ready
    // - We never want this method to return a stale cert
    
    const { dns } = this;
    if (!dns) throw Error('dns missing');
    
    if (!dns.certPrm) dns.certPrm = (async () => {
      
      const { logger } = inp;
      const { rootHost, configFact, letsEncrypt } = dns;
      
      // Try disk cache
      const fact = configFact.kid([ 'letsEncrypt', rootHost ]);
      const factCert = await fact.getData<null | Cert>('json');
      if (factCert && this.isCertFresh(factCert)) return factCert;
      
      const cert = await logger.scope('acme.letsEncrypt', {}, async () => {
        
        // Disk cache miss - perform acme
        
        const accountKey = letsEncrypt.accountPrivateKey ?? await acmeCrypto.createPrivateKey();
        
        const dirUrlName = ({ m1: 'staging', m2: 'production' } as const)[letsEncrypt.directory];
        const client = new AcmeClient({
          directoryUrl: acmeDirectory.letsencrypt[dirUrlName],
          accountKey
        });
        
        const [ prv, csr ] = await acmeCrypto.createCsr({
          commonName: `*.${rootHost}`,
          altNames: [ `*.${rootHost}` ]
        });
        const pub = await client.auto({
          
          csr,
          email: letsEncrypt.email,
          termsOfServiceAgreed: true,
          challengePriority: [ 'dns-01' ],
          
          challengeCreateFn: async (authz, { type, token }, auth) => {
            
            Error[cl.assert](type, t => t === 'dns-01');
            await this.dnsMod({ logger, op: 'set', type: 'txt', key: `_acme-challenge.${rootHost}`, val: `"${auth}"` });
            
          },
          
          // Fired automatically once verification succeeds or fails
          challengeRemoveFn: async (authz, { type, token }, auth) => {
            
            Error[cl.assert](type, t => t === 'dns-01');
            await this.dnsMod({ logger, op: 'rem', type: 'txt', key: `_acme-challenge.${rootHost}`, val: `"${auth}"` });
            
          }
          
        });
        const certInfo = acmeCrypto.readCertificateInfo(pub);
        
        return { '!prv': prv.toString(), pub, expiryMs: certInfo.notAfter.getTime() };
        
      });
      
      await fact.setData(cert);
      return cert;
      
    })().then(cert => dns.certPrm = cert);
    
    const cert = await dns.certPrm;
    if (!this.isCertFresh(cert)) {
      // Refresh the cert by invalidating it and calling recursively
      dns.certPrm = null;
      return this.getLetsEncryptCert(inp);
    }
    
    return cert;
    
  }
  
  protected async initIpSelfSignHttp(inp: { logger: Logger, platform: Platform }) {
    
    const { logger = Logger.dummy, platform: { ipHost } } = inp;
    
    await logger.scope('initPlatformHttp', { ipHost }, async () => {
      
      const platformAdminPollen = this.platformAdminPollenGet(inp.platform);
      await platformAdminPollen.fly({ ipHost }, async inp => {
        await inp.state.launchMainHttp({ type: 'ip', certType: 'self', host: inp.inp.ipHost });
      });
      
    });
    
  }
  
  protected async initDnsAuthSignHttp(inp: { logger: Logger, platform: Platform, dnsHost: `${string}.${string}` }) {
    
    const { logger = Logger.dummy, platform, dnsHost } = inp;
    
    const cert = await this.getLetsEncryptCert({ logger });
    
    await logger.scope('initPlatformHttp', { dnsHost }, async logger => {
      
      const platformAdminPollen = this.platformAdminPollenGet(platform);
      
      await platformAdminPollen.fly({ dnsHost, cert }, async inp => {
        const api = await inp.state.launchMainHttp({ type: 'dns', certType: 'auth', host: inp.inp.dnsHost });
        api.setCert(inp.inp.cert);
      });
      logger.log({ $$: 'launch' });
      
      // Note dns has already been set up - we can poll the http "ping" endpoint
      const http = new PollenHttp({
        flowerId: `domain/${dnsHost}` as const,
        httpInp: {
          netProc: { proto: 'https', addr: dnsHost, port: 443 },
          method: 'post',
          path: [],
          body: {}
        }
      });
      await retry({
        maxDelayMs: 60 * 1000,
        delayMs: n => Math.min(n * 250, 5000),
        retry: () => true,
        fn: () => http.fly({ path: [ 'ping' ] })
      });
      logger.log({ $$: 'ready' });
      
    });
    
  }
  
  protected async * taskSurvey(inp: { statusFilter?: null | 'running' | 'stopped' }) {
    
    const { ecsClient, cluster } = await this.getDef();
    const { statusFilter: status = null } = inp;
    
    // List tasks and describe each such listed task; performs one list and one describe query
    // for every 100 tasks; for giant task clusters the generator consumer should pace iteration
    
    const awsTasks = funnel((status ? [ status ] as const : [ 'running', 'stopped' ] as const).map(status => paging(async last => {
      
      // Consider speeding this up - code would be uglier, but the following list request
      // shouldn't wait for the previous batch's describe request...
      
      const { nextToken: next = null, taskArns = [] } = await ecsClient.send(new ListTasksCommand({
        cluster: cluster.name,
        ...(status ? { desiredStatus: status[cl.upper]() } : {}),
        ...(last   ? { nextToken:     last               } : {}),
        maxResults: 100 // The following `DescribeTasksCommand` accepts max 100 arns at a time
      }));
      
      const { tasks: awsTasks = [] } = !taskArns.length ? { tasks: [] } : await ecsClient.send(new DescribeTasksCommand({
        cluster: cluster.name,
        tasks: taskArns,
        include: [ 'tags'[cl.upper]() ]
      }));
      
      return { next, page: awsTasks };
      
    })));
    
    // Need to dedupe returned tasks - same task can reappear in funnel inputs
    const seen = new Set<string>();
    for await (const awsTask of awsTasks) {
      
      if (seen.has(awsTask.taskArn!)) continue;
      seen.add(awsTask.taskArn!);
      
      yield this.makeTask(awsTask);
      
    }
    
  }
  
  public async runDaemons(inp: { logger: Logger }) {
    
    const { hostedZoneId } = await this.getDef();
    const { logger } = inp;
    
    const cancelable = (inp: { delayMs: number, fn: (on: () => boolean) => Promise<void> }) => {
      
      const { delayMs, fn } = inp;
      
      let on = true;
      let cancel = () => { on = false; };
      const prm = (async () => { while (true) {
        
        const prm = Promise[cl.later]();
        const timeout = setTimeout(() => prm.resolve(), delayMs);
        cancel = () => { on = false; clearTimeout(timeout); prm.resolve(); }
        await prm;
        
        if (!on) break;
        
        await fn(() => on);
        if (!on) break;
        
      }})().finally(() => cancel());
      
      return { cancel: () => (cancel(), prm) };
      
    };
    
    const orphanSweepLoop = !hostedZoneId ? { cancel: async () => {} } : cancelable({
      
      // Every 20min
      delayMs: 1000 * 60 * 20,
      
      // `this.orphanSweep` performs logging; failures are logged but without terminating the loop
      fn: () => this.orphanSweep({ logger, ignoreRecent: true }).catch(err => {})
      
    });
    
    const letsEncryptCertUpdateSweepLoop = !hostedZoneId ? { cancel: async () => {} } : cancelable({
      
      // Every 1hr
      delayMs: 1000 * 60 * 60 * 1,
      
      fn: () => this.renewCertSweep({ logger, delayMs: 1000 * 3 }).catch(err => {})
      
    });
    
    return { cancel: () => Promise.all([
      orphanSweepLoop.cancel(),
      letsEncryptCertUpdateSweepLoop.cancel()
    ])};
    
  }
  
  public async platformSurvey(inp: { logger: Logger, status?: 'active' | 'extant', requireLilacActive?: boolean }) {
    
    const { logger, status = 'active', requireLilacActive = true } = inp;
    
    return logger.scope('platformSurvey', {}, async logger => {
      
      // This function can result in a lot of tasks - it should return an iterator, not the list
      
      const tasks = await this.taskSurvey({
        
        // If `inp.status === 'extant'` we pass no `status` to request all tasks, unfiltered
        statusFilter: ({ active: 'running', extant: null } as const)[status]
        
      })[cl.toArr](v => v);
      
      return Promise[cl.allArr](tasks
        .map(task => this.taskToPlatform({ logger, task, requireLilacActive }).catch(err => {
          
          if (err.message === 'task missing')           return cl.skip;
          if (err.message === 'task stopped')           return cl.skip;
          if (err.message === 'task lilac tag missing') return cl.skip;
          throw err;
          
        }))
      );
      
    });
    
  }
  
  public async platformLaunch(inp: { logger: Logger }) {
    
    const { cluster, family, subnetIds, securityGroupId, ecsClient } = await this.getDef();
    const { logger = Logger.dummy } = inp;
    
    return logger.scope('platformLaunch', {}, async (logger) => {
      
      // Check if the cluster is still alive
      const tagsRes = await ecsClient.send(new ListTagsForResourceCommand({ resourceArn: cluster.id }));
      const tags = (tagsRes.tags ?? [])[cl.toObj](({ key, value = null }) => [ key!, value ] as const);
      if (tags[cl.at]('gershyLilacActive', 'ya') === 'no') throw Error('platformer inactive')[cl.mod]({ tags });
      
      // Overall process:
      // 1. Spawn new task; pass it `adminPass` via env vars
      // 2. Poll for task liveliness and public ip (uses `getPlatform` without `requireLilacActive`)
      // 3. Wait for the task's admin api to become live (poll http requests until success)
      // 4. Use that admin api to initialize the task's main api using either a letsEncrypt or
      //    self-signed cert
      // 5. Use the admin api to obtain the task's final main api connection details
      // 6. The task is now a "platform"; it's healthy with a publicly addressable TLS main api
      
      // Run a task, giving it an admin pass for privileged (arbitrary execution) access
      const adminPass = (3)[cl.toArr](() => Math.random().toString(36).slice(2)).join('');
      const runTask = await ecsClient.send(new RunTaskCommand({
        cluster: cluster.name,
        taskDefinition: family,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: subnetIds,
            securityGroups: [ securityGroupId ],
            assignPublicIp: 'ENABLED'
          }
        },
        tags: {
          gershyLilacStatus: 'queued',
          gershyLilacAdminPass:    adminPass
        }[cl.toArr]((v, k) => ({ key: k, value: v })),
        overrides: {
          containerOverrides: [
            {
              name: this.flowerId.split('/').at(-1)!,
              environment: [ { name: 'gershyLilacAdminPass', value: adminPass } ]
            }
          ]
        }
      }));
      
      // Ensure a task has resulted
      const awsTask = runTask.tasks?.[0] ?? null;
      if (!awsTask) throw Error('run task failed')[cl.mod]({ failures: runTask.failures ?? [], tasks: runTask.tasks ?? [] });
      
      // Get the corresponding platform, waiting for task readiness and networking - this context
      // doesn't wait for the platform to become lilac-active; this context is *responsible* for
      // ensuring liveliness!
      const task = this.makeTask(awsTask);
      const platform = await this.taskToPlatform({ logger, task, requireLilacActive: false });
      logger.log({ $$: 'platform', platform });
      
      // Poll the admin api to confirm it's live
      const platformAdminPollen = this.platformAdminPollenGet(platform);
      await retry({ maxDelayMs: 30 * 1000, delayMs: n => Math.min(1500, n * 250), retry: () => true, fn: async attempt => {
        
        // TODO: This can fail for some reason... with the task never coming alive??
        
        logger.log({ $$: 'attempt', attempt });
        
        await platformAdminPollen.fly({}, inp => {
          return { env: { ...(process.env as Obj<string>) } };
        });
        
      }});
      logger.log({ $$: 'lilacActive' });
      
      const { dns } = this;
      const dnsHost = !dns ? null : await logger.scope('dns', {}, async logger => {
        
        // Make the task addressable via a unique subdomain when `this.dns` is set
        
        const { rootHost } = dns;
        const { ipHost } = platform;
        
        // TODO: tag the task with the dns record; clean it up!!
        // End-of-day cleanup can determine stale dns records based on no corresponding task
        const dnsHost = `${task.id.split('/').at(-1)!}.${rootHost}`;
        await this.dnsMod({ logger, op: 'set', type: 'a', key: dnsHost, val: ipHost });
        
        return dnsHost as `${string}.${string}`;
        
      });
      
      if (dnsHost) await this.initDnsAuthSignHttp({ logger, platform: platform, dnsHost });
      else         await this.initIpSelfSignHttp ({ logger, platform: platform });
      
      // Query hosting details from the admin api, to allow clients to connect to the main api
      const hosting = await platformAdminPollen.fly({}, async inp => {
        
        const api = inp.state.mainApi!;
        return {
          netProc: { proto: 'https', addr: api.host, port: 443 },
          ...(api.cert ? { cert: api.cert } : {})
        };
        
      });
      logger.log({ $$: 'hosting', hosting });
      
      // We've performed admin initialization; tag the task as "lilac-active"
      await ecsClient.send(new TagResourceCommand({
        resourceArn: task.id,
        tags: [
          { key: 'gershyLilacStatus', value: 'active' },
          ...(dnsHost ? [{ key: 'gershyLilacDnsHost', value: dnsHost }] : [])
        ]
      }));
      
      platform[cl.merge]({ tags: cl.skip, dnsHost });
      
      logger.log({ $$: 'tagged' });
      
      return platform;
      
    });
    
  }
  
  public async platformSessionLaunch(inp: { logger: Logger, platform: Platform }) {
    
    const { logger, platform } = inp;
    
    return logger.scope('platformSessionLaunch', {}, async logger => {
      
      // Use admin api to get main api connection details
      const pollen = this.platformAdminPollenGet(platform);
      const { netProc, cert = null } = await pollen.fly({}, inp => {
        
        const api = inp.state.mainApi!;
        return {
          netProc: { proto: 'https', addr: api.host as `${string}.${string}`, port: 443 },
          ...(api.certType === 'self' ? { cert: api.cert![cl.slice]([ 'pub' ]) } : {})
        };
        
      });
      logger.log({ $$: 'connection', netProc, cert });
      
      const platformPollen = new PollenPlatformSession({
        flowerId: `domain/${netProc.addr}` as const,
        ...(cert && { cert })
      });
      await platformPollen.getDef(logger); // Trigger websocket instantiation and user id negotiation as part of the "join" operation
      
      return platformPollen;
      
    });
    
  }
  
  public async platformCancel(inp: { logger: Logger, platform: { task: { id: string }, ipHost: string, dnsHost?: null | string } }) {
    
    // LIFECYCLE MOMENTS:
    // - queued
    // - active (formerly "launch")
    // - waking
    // - notice
    // - accept
    // - reject
    // - glitch
    // - finish
    // 
    // INTERACTION:
    // - survey ("population tally")
    // - launch
    // - regard ("view an individual" - consider "verify"?)
    // - cancel
    // 
    // IPC:
    // - tell
    // - hear
    
    const { logger, platform } = inp;
    const { cluster, ecsClient } = await this.getDef();
    
    return logger.scope('platformCancel', {}, async (logger) => {
      
      await Promise.all([
        
        ecsClient.send(new StopTaskCommand({ cluster: cluster.name, task: platform.task.id })),
        ...(platform.dnsHost
          ? [ this.dnsMod({ logger, op: 'rem', type: 'a', key: platform.dnsHost, val: platform.ipHost }) ]
          : []
        )
        
      ]);
      
    });
    
  }
  
  public async cancel(inp: { logger: Logger }) {
    
    // Only concerned with fargate task cleanup here; `terraform destroy` force-destroys r53
    
    const { cluster, ecsClient, ec2Client } = await this.getDef();
    const { logger } = inp;
    
    const delayMs = { task: 500, sweep: 3000 };
    
    return logger.scope('platformerCancel', {}, async logger => {
      
      // Mark the cluster as inactive to prevent new tasks going live
      await ecsClient.send(new TagResourceCommand({ resourceArn: cluster.id, tags: [{ key: 'gershyLilacActive', value: 'no' }] }));
      
      const stopRequested = new Set<string>();
      while (true) {
        
        const counts = await logger.scope('sweep', {}, async logger => {
          
          // Page through all tasks, running and stopping
          const taskArnGen = funnel([
            
            paging<string, string>(last => ecsClient.send(new ListTasksCommand({
              cluster: cluster.name,
              desiredStatus: 'running'[cl.upper](),
              ...(last ? { nextToken: last } : {}),
              maxResults: 100 // The following `DescribeTasksCommand` accepts max 100 arns at a time
            })).then(v => ({ next: v.nextToken ?? null, page: v.taskArns ?? [] }))),
            
            paging<string, string>(last => ecsClient.send(new ListTasksCommand({
              cluster: cluster.name,
              desiredStatus: 'stopped'[cl.upper](),
              ...(last ? { nextToken: last } : {}),
              maxResults: 100 // The following `DescribeTasksCommand` accepts max 100 arns at a time
            })).then(v => ({ next: v.nextToken ?? null, page: v.taskArns ?? [] })))
            
          ]);
          
          const counts: Obj<number> = { total: 0 };
          for await (const taskArn of taskArnGen) {
            
            await new Promise(r => setTimeout(r, delayMs.task));
            
            // TODO: it's a pity we're not batching these describe calls...
            const { tasks: [ awsTask = null ] = [] } = await ecsClient.send(new DescribeTasksCommand({ cluster: cluster.name, tasks: [ taskArn ] }));
            if (!awsTask) continue;
            
            const task = this.makeTask(awsTask);
            if (task.stopped) continue;
            if (!task.eni)    continue;
            counts.total++;
            counts[task.status] = (counts[task.status] ?? 0) + 1;
            
            const eni = await ec2Client.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [ task.eni!.id ] })).catch(err => {
              if (err.Code === 'InvalidNetworkInterfaceID.NotFound') return null;
              throw err;
            });
            if (!eni) continue;
            
            const ipHost = eni.NetworkInterfaces?.[0]?.Association?.PublicIp ?? null;
            if (!ipHost) continue;
            
            if (stopRequested.has(taskArn)) continue;
            stopRequested.add(taskArn);
            await this.platformCancel({ logger, platform: {
              task,
              ipHost,
              ...(this.dns && { dnsHost: `${task.id.split('/').at(-1)}.${this.dns.rootHost}` })
            }});
            logger.log({ $$: 'stopRequested', task: { id: taskArn } });
            
          }
          
          return counts; 
          
        });
        
        // TODO: consider also forcing this loop to run for minimum e.g. 3min? That way we'll pick up any eventually-consistent tasks that were launched right before the platformer was cancelled...
        logger.log({ $$: 'progress', counts });
        if (counts.total === 0) break;
        
        await new Promise(r => setTimeout(r, delayMs.sweep));
        
      }
      
    });
    
  }
  
  public async fly(inp: never) { throw Error('script missing'); }
  
};

export class PollenPlatformSession extends Pollen<{ http: PollenHttp; sokt: PollenSokt, userId: string, hear: AsyncGenerator<Json> }> {
  
  protected cert: null | { pub: string };
  
  constructor(inp: PollenInp<'domain'> & { cert?: { pub: string } }) {
    
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
      
      // An agent, and wrapper fetch+SoktCls values that use the agent as dispatcher
      const agent = new UndiciAgent({ connect: { ca: this.cert.pub, rejectUnauthorized: true } });
      const fetch = (url: string, inp: Obj<any>) => undiciFetch(url, { ...inp, dispatcher: agent });
      const SoktCls = function(url, opts: Obj<any> = {}) {
        return new UndiciWebSocket(url, { ...opts, dispatcher: agent });
      } as any as typeof UndiciWebSocket;
      
      logger.log({ $$: 'selfSign' });
      
      return { agent, fetch, SoktCls };
      
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
    await logger.scope('http', {}, async logger => {
      await http.getDef(logger);
    });
    
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
