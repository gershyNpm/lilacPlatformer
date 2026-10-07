import '@gershy/clearing';
import { Flower, Garden, PetalTerraform, Soil }                           from '@gershy/lilac';
import phrasing                                                           from '@gershy/util-phrasing';
import * as tf                                                            from '../util/terraform.ts';
import * as aws                                                           from '../util/aws.ts';
import proc                                                               from '@gershy/nodejs-proc';
import { DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { Fact, rootFact, tempFact }                                       from '@gershy/disk';
import scriptBundle                                                       from '@gershy/script-bundle';
import jsfnEncode, { type Jsfn, type JsImport }                           from '@gershy/util-jsfn-encode';
import slashEscape                                                        from '@gershy/util-slash-escape';
import hash                                                               from '@gershy/util-hash';
import { getImports, mergeJsImports }                                     from '../util/jsfnImport.ts';
import { PollenPlatformer, type UndiciUtils }                             from './pollenPlatformer.ts';
import platformScript                                                     from './platformScript.ts';
import type { AnyLambda }                                                 from '@gershy/lilac-lambda';
import type { Domain }                                                    from '@gershy/lilac-domain';
import type Logger                                                        from '@gershy/logger';
import type { AwsRegionTerm, ServiceMap }                                 from '@gershy/lilac';

// TODO: HEEERE1
// [X] Refresh letsencrypt cert in all fargate tasks when it's nearing expiry
// [ ] Use shared NodeHttpHandlers from lilac's exports
// [ ] Store letsencrypt cert in s3 / sm?
// [ ] Track aws permissions for platformer pollen (it needs a *bunch* - ecr, ecs, s3, route53, etc)

// - Either Output with docker push should use pollen, or delete ecrClient from Platformer
// - There's starting to be a lot of Z-Z-Zs floating around, pls handle
// 
// - Terraform handle and unique identifier values need standardizing! Iam for example is a tricky
//   one - e.g. a BinDb may add iam permissions for each of its connected lambdas. How to assign
//   handles and ids? Should they embed "iam", "binDb", and "lambda"? With ids for each??
// - Some pretty serious bundled payloads are sticking around in memory - e.g. Lambda, Platformer
//   hang onto `script` + `packedCode` (`zippedCode`) - the strategy should be for payloads like
//   these to be `yield`ed immediately as `PetalTerraform.File`s; improvements could look like:
//   `PetalTerraform.File`'s "files" return value can be file handles so literal payload content
//   doesn't stay in memory, and `PetalTerraform.File` makes its underlying storage fact
//   addressable so payloads can live there
// - Deleted lilac's readme.caller.md - should probably write a readme.pollen.md explaining how
//   service map and flower id work together, are generated / propagated / consumed!

type MbPrm<V> = Promise<V> | V;

export type Session = {
  id: string,
  sokt: any,
  send: (inp: Json) => Promise<void>
};
export class Platformer<LocalData extends Jsfn, LaunchData> extends Flower {
  
  static getAwsServices() { return [ 'ec2', 'cloudwatch' ] as const; }
  
  protected region:     AwsRegionTerm;
  protected domain:     null | Domain;
  protected certFact:   null | Fact;
  protected name:       string;
  protected power:     -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5;
  protected localData:  ((inp: Platformer<any, any>                                                                                                            ) => MbPrm<LocalData>) | MbPrm<LocalData>;
  protected launchFn:   ((inp: { debug: boolean, logger: Logger, jsfnImport: (fp: string) => any, localData: LocalData                                        }) => LaunchData);
  protected invokeFn:   ((inp: { debug: boolean, logger: Logger, jsfnImport: (fp: string) => any, launchData: Awaited<LaunchData>, session: Session, inp: any }) => Promise<Json>);
  protected baseUrl:    string;
  protected pistils:    { lbd: AnyLambda, mode: 'view' | 'mark' | 'keep' }[];
  protected env:        Obj<Json>;
  protected configFact: null | Fact;
  constructor(inp: {
    garden?:     Garden<any, any>,
    region?:     string,
    certFact?:   Fact,
    domain?:     Domain,
    name:        string,
    baseUrl:     string,
    power:       -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5,
    localData:   ((inp: Platformer<any, any>                                                                                                            ) => (Promise<LocalData> | LocalData)) | Promise<LocalData> | LocalData,
    launchFn:    ((inp: { debug: boolean, logger: Logger, jsfnImport: (fp: string) => any, localData: LocalData                                        }) => LaunchData);
    invokeFn:    ((inp: { debug: boolean, logger: Logger, jsfnImport: (fp: string) => any, launchData: Awaited<LaunchData>, session: Session, inp: any }) => Promise<Json>);
    configFact?: Fact,
    manualConfirmations?: {
      nameServersConnected?: boolean
    }
  }) {
    
    // Note any camelcase name will do, but actual resources will be converted to kebab case
    Error[cl.assert](inp.name, inp => /^[a-z][a-zA-Z0-9]*$/.test(inp));
    
    super(inp);
    
    const region = inp.region ?? this.garden.defaults.region ?? null;
    if (!region) throw Error('region missing');
    this.region = region;
    
    this.domain = inp.domain ?? null;
    this.certFact = inp.certFact ?? null;
    this.name = inp.name;
    this.baseUrl = inp.baseUrl;
    this.power = inp.power;
    this.localData = inp.localData;
    this.launchFn = inp.launchFn;
    this.invokeFn = inp.invokeFn;
    this.configFact = inp.configFact ?? null;
    this.pistils = [];
    this.env = {};
    
  }
  
  private getFlowerName() { return `${this.garden.pfx}-${phrasing('camel->kebab', this.name)}`; }
  public getFlowerId() { return `awsFargate/${this.region}/${this.getFlowerName()}/${this.getFlowerName()}` as const; }
  
  public * getDependencies() {
    yield* super.getDependencies();
    if (this.domain) yield this.domain;
    for (const pistil of this.pistils) yield pistil.lbd;
  }
  
  protected getLocalData() {
    
    if (cl.inCls(this.localData, Function)) this.localData = this.localData(this);
    return this.localData as LocalData | Promise<LocalData>;
    
  }
  
  public async getScript(inp: { lang: 'ts' | 'js' }) {
    
    // TODO: some stuff here is directly copy-pasted from lilac lambda
    
    const jsfn = {
      localData: jsfnEncode({ baseUrl: this.baseUrl,    val: await this.getLocalData() }),
      launchFn:  jsfnEncode({ baseUrl: this.baseUrl,    val: this.launchFn             }),
      invokeFn:  jsfnEncode({ baseUrl: this.baseUrl,    val: this.invokeFn             }),
      mainFn:    jsfnEncode(platformScript)
    } satisfies Obj<{ jsImports: JsImport[], code: string }>;
    
    return [
      
      ...getImports({
        mergedImports: mergeJsImports([
          { varDef: null, importPath: '@gershy/clearing' }, // Ensure clearing is imported
          ...jsfn[cl.toArr](v => v.jsImports).flat(1),
        ]),
        lang: inp.lang
      }),
      
      `const lilacGlobal = JSON.parse(process.env.${phrasing('camel->snake', 'gershyLilac')} ?? '{}');`,
      `process[Symbol.for('@gershy/lilac/garden')] = lilacGlobal.garden ?? {};                `,
      
      `const localData = ${jsfn.localData.code};                                              `,
      `const launchFn = ${jsfn.launchFn.code};                                                `,
      `const invokeFn = ${jsfn.invokeFn.code};                                                `,
      `(${jsfn.mainFn.code})({                                                                `,
      `  jsfnImport: jsImp => Error('jsfn import failed')[cl.fire]({ import: jsImp }),        `,
      `  name: '${slashEscape(this.name, `'`)}',                                              `,
      `  debug: ${this.garden.debug ? 'true' : 'false'},                                      `,
      `  localData, launchFn, invokeFn,                                                       `,
      `});                                                                                    `,
      
    ].join('\n');
    
  }
  async getBundle(inp: { lang: 'ts' | 'js' }): Promise<{ script: string, packedCode: string, hash: string }> {
    
    const script = await this.getScript(inp);
    
    if (!this.baseUrl[cl.hasHead]('file:///'))
      throw Error('non-file bundle base url invalid')[cl.mod]({ baseUrl: this.baseUrl });
    
    const fileFact = rootFact.kid([ this.baseUrl.slice('file:///'.length) ]);
    const dirFact = fileFact.par();
    
    const packedCode = await scriptBundle({ debug: this.garden.debug, platform: 'node/cjs', script, dirFact });
    
    return { script, packedCode, hash: await hash(packedCode) };
    
  }
  
  async cultivate(serviceMap: ServiceMap.Full) {
    
    this.env[cl.merge]({ gershyLilac: { garden: {
      pfx: this.garden.pfx,
      debug: this.garden.debug,
      serviceMap
    }}});
    
  }
  
  async * computePetals() {
    
    // Note the iac defines vpc+subnet networking, a fargate cluster, security group and a task
    // definition, but doesn't make any associations between these - the association is instead
    // made at execution time via the RunTask call
    
    // TODO: Consider cloudflare free tier! Hides fargate ips from dns; the igw -> eni -> fargate
    // network chain can be configured to block everyone other than the cloudflare proxy, enabling
    // rate limiting and ddos protection. Minimal latency change for users nearby aws region;
    // *improved* latency for distant users. Handshakes become very fast (they terminate at the
    // cloudflare edge, not aws region). Websockets can be terminated if inactive for ~100 seconds
    // (need application-level heartbeat); cloudflare may begin requiring payment for heavy
    // websocket use (many simultaneous connections). Every fargate task will need a corresponding
    // cloudflare dns record (so available subdomains map to fargate)
    
    const { Resource, Data, File, Output } = PetalTerraform;
    
    const regionProvider = tf.provider(this.garden.defaults.region, this.region);
    const handle = (n: string[] = []) => phrasing('parts->camel', [ 'platformer', this.name, ...n ]);
    const flowerName = this.getFlowerName();
    
    // This VPC holds the public networking pieces for Platformer tasks.
    const vpc = new Resource('awsVpc', handle(), {
      ...regionProvider,
      cidrBlock: '10.0.0.0/16',
      enableDnsSupport: true,
      enableDnsHostnames: true
    });
    yield vpc;
    
    const availabilityZones = new Data('awsAvailabilityZones', handle(), { ...regionProvider, state: 'available' });
    const publicSubnets = new Resource('awsSubnet', handle(), {
      
      // Define a subnet-per-az
      
      ...regionProvider,
      forEach: `| { for idx, zone in ${availabilityZones.refStr('names')} : zone => idx }`,
      vpcId: vpc.ref('id'),
      cidrBlock: `| cidrsubnet(${vpc.refStr('cidrBlock')}, 8, each.value)`, // Each subnet (one per az) has a length-8 cidr block (251 ips total due to 'minus 5' rule where aws reserves some ips)
      availabilityZone: '| each.key',
      mapPublicIpOnLaunch: true
      
    });
    yield* [ availabilityZones, publicSubnets ];
    
    const internetGw = new Resource('awsInternetGateway', handle(), { ...regionProvider, vpcId: vpc.ref('id') });
    const routeTable = new Resource('awsRouteTable', handle(), {
      
      // Ip 0.0.0.0 is the default vpc route used if no other routing rules matched
      // Link 0.0.0.0 to public internet, allowing arbitrary requests made by resources inside the
      // vpc (fargate tasks) to resolve!
      
      ...regionProvider,
      vpcId: vpc.ref('id'),
      $route: { cidrBlock: '0.0.0.0/0', gatewayId: internetGw.ref('id') }
      
    });
    const routeTableAssoc = new Resource('awsRouteTableAssociation', handle([ 'routeTableAssoc' ]), {
      
      // Associate every subnet with the route table
      
      ...regionProvider,
      forEach: `| ${publicSubnets.refStr()}`,
      subnetId: '| each.value.id',
      routeTableId: routeTable.ref('id')
      
    });
    const securityGroup = new Resource('awsSecurityGroup', handle([ 'publicSg' ]), {
      
      // Permit all inbound/outbound traffic
      
      ...regionProvider,
      name: `${this.getFlowerName()}-security-group`,
      vpcId: vpc.ref('id'),
      $ingress: { fromPort: 0, toPort: 0, protocol: '-1', cidrBlocks: [ '0.0.0.0/0' ] },
      // $ingress: [
      //   { fromPort:  80, toPort:  80, protocol: '-1', cidrBlocks: [ '0.0.0.0/0' ] },
      //   { fromPort: 443, toPort: 443, protocol: '-1', cidrBlocks: [ '0.0.0.0/0' ] }
      // ],
      $egress:  { fromPort: 0, toPort: 0, protocol: '-1', cidrBlocks: [ '0.0.0.0/0' ] }
      
    });
    yield* [ internetGw, routeTable, routeTableAssoc, securityGroup ];
    
    const ecrRepo = new Resource('awsEcrRepository', handle(), {
      ...regionProvider,
      name: flowerName,
      imageTagMutability: 'MUTABLE',
      forceDelete: true
    });
    yield ecrRepo;
    
    yield new Resource('awsEcrLifecyclePolicy', handle(), {
      ...regionProvider,
      repository: ecrRepo.ref('name'),
      policy: { $$json: {
        rules: [{
          // Note that our images are *always* tagged (with their source code hash)
          rulePriority: 1,
          description: 'Max 10 tagged images',
          selection: {
            tagStatus: 'tagged',
            tagPrefixList: [ 'hash-' ],
            countType: 'imageCountMoreThan',
            countNumber: 10
          },
          action: { type: 'expire' }
        }]
      }}
    });
    
    const taskExecRole = new Resource('awsIamRole', handle(), {
      ...regionProvider,
      name: flowerName,
      assumeRolePolicy: { $$json: aws.capitalKeys({
        version: '2012-10-17',
        statement: [{
          effect: 'Allow',
          action: 'sts:AssumeRole',
          principal: { service: 'ecs-tasks.amazonaws.com' }
        }]
      })}
    });
    yield taskExecRole;
    
    yield new Resource('awsIamRolePolicyAttachment', handle(), {
      ...regionProvider,
      role: taskExecRole.ref('name'),
      policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'
    });

    // Like Lambda, provision the log group explicitly and point the runtime at it.
    const logGroup = new Resource('awsCloudwatchLogGroup', handle([ 'logGroup' ]), {
      ...regionProvider,
      name: `/ecs/${flowerName}`,
      retentionInDays: 14
    });
    yield logGroup;
    
    const ecsCluster = new Resource('awsEcsCluster', handle(), {
      
      ...regionProvider,
      name: flowerName,
      $setting: { name: 'containerInsights', value: 'enabled' }
      
    });
    yield ecsCluster;
    
    // No capacity provider required - we're using ad-hoc, manually demanded platforms!
    // const clusterCapacityProviders = new Resource('awsEcsClusterCapacityProviders', `${this.name}Cluster`, {
    //   ...regionProvider,
    //   clusterName: cluster.ref('name'),
    //   capacityProviders: [ 'fargate'[cl.upper]() ], // Could add FARGATE_SPOT, but such instances may randomly be reclaimed by aws
    //   $defaultCapacityProviderStrategy: {
    //     capacityProvider: 'fargate'[cl.upper](),
    //     base: 1,
    //     weight: 1
    //   }
    // });
    // yield clusterCapacityProviders;
    
    const cpu = 1024 * (2 ** this.power);
    const taskDefinition = new Resource('awsEcsTaskDefinition', handle(), {
      
      ...regionProvider,
      
      // One task definition per Platformer; each launched task is a platform instance.
      family: flowerName,
      requiresCompatibilities: [ 'fargate'[cl.upper]() ],
      networkMode: 'awsvpc',
      executionRoleArn: taskExecRole.ref('arn'),
      
      // `cpu` and `memory` need to be strings in terraform
      // Consider: expose more options for `memory` than just `[ cpu * 2 ]`
      ...{ cpu, memory: cpu * 2 }[cl.map](v => v.toString(10)),
      
      containerDefinitions: { $$json: [{
        
        name: flowerName,
        image: `${tf.embed(ecrRepo.refStr('repositoryUrl'))}:latest`, // Always pull latest image
        // command: [ ' node', '-e', 'setInterval(() => {}, 1 << 30)' ], // Don't set this - it overrides dockerfile ENTRYPOINT / CMD
        essential: true, // This container is essential to the task, i.e. if it dies, kill the task
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            [phrasing('camel->kebab', 'awslogsGroup'       )]: logGroup.ref('name'),
            [phrasing('camel->kebab', 'awslogsRegion'      )]: this.region,
            [phrasing('camel->kebab', 'awslogsStreamPrefix')]: flowerName,
          }
        },
        
        environment: { AWS_REGION: this.region, ...this.env }[cl.toArr]((v, k) => ({
          name: k,
          value: cl.isCls(v, String) ? v : { $$json: v }
        })),
        
      }]}
      
    });
    yield taskDefinition;
    
    const { script, packedCode, hash } = await this.getBundle({ lang: 'js' });
    yield new File(`literal/platformer/${this.name}.ts`, script);
    yield new File(`literal/platformer/${this.name}.js`, packedCode);
    
    // A post-terraform-install action to perform the ecr docker image push
    const imgInp = { repoUrl: ecrRepo.ref('repositoryUrl') };
    yield new Output(handle(), imgInp, inp => this.garden.logger.scope('ecrImage', {}, async logger => {
      
      // "registry": a set of repos (little reason to have more than 1 per region)
      // "repo": named collection of ECS images, with corresponding lifecycle and permissions
      // "cluster": compute/isolation group for tasks
      
      const { repoUrl } = inp as { repoUrl: string  };       // `inp.repoUrl` Looks like "123456789012.dkr.ecr.ca-central-1.amazonaws.com/cluster"
      const [ registryAddr, repoName ] = repoUrl.split('/'); // The "/" url delimiter splits the address from the repo name
      const registryId = registryAddr.split('.')[0];         // Parse the registry id from the url (it's the 1st component)
      
      const ecr = new ECRClient({}
        [cl.merge](this.garden.defaults.awsClientConfig as Soil.AwsClientConfig)
        [cl.merge]({ region: this.region })
      );
      const existingImgNum = await ecr.send(new DescribeImagesCommand({ repositoryName: repoName, imageIds: [{ imageTag: `hash-${hash}` }] })).then(
        res => res.imageDetails?.length ?? 0,
        (err: Error) => err.name === 'ImageNotFoundException' ? 0 : err[cl.fire]()
      );
      
      logger.log({ $$: 'existingImages', hash, num: existingImgNum });
      
      // If image already exists don't bother
      if (existingImgNum) return;
      
      const ecrAuth = await (async () => {
        
        const auth = await ecr.send(new GetAuthorizationTokenCommand({ registryIds: [ registryId ] }));
        const authPayload = auth.authorizationData?.[0]; // We passed `registryIds.length === 1` so we get one result
        if (!authPayload?.authorizationToken) throw Error('ecr auth token missing')[cl.mod]({ auth });
        
        const token = authPayload.authorizationToken;
        
        const [ user, pass ] = Buffer.from(token, 'base64').toString('utf8')[cl.cut](':', 1);
        
        return { token, user, '!pass': pass };
        
      })();
      
      logger.log({ ecrAuth });
      
      const dockerOpsFact = tempFact.kid([ Math.random().toString(36).slice(2) ]);
      const dockerEnv = {
        
        // Remove any "docker_"-prefixed env vars
        ...{ ...process.env }[cl.map]((v, k) => k[cl.lower]()[cl.hasHead]('docker_') ? cl.skip : v),
        
        // Control the docker config location
        DOCKER_CONFIG: dockerOpsFact.fsp()
        
      };
      const dockerBuilderId = `lilac-${Math.random().toString(36).slice(2)}`;
      
      const dockerPluginDirs = await (async () => {
        
        // Super ugly, because there are many possibilities for where buildx is stored - I hate
        // that this approach is necessary but it's possibly the only way...
        const possibleFps = new Set([
          
          // posix
          ...(process.env.DOCKER_CLI_PLUGIN_EXTRA_DIRS?.split(/[:;]/) ?? []),
          ...(process.env.HOME ? [ `${process.env.HOME}/.docker/cli-plugins` ] : []),
          '/Applications/Docker.app/Contents/Resources/cli-plugins',
          '/opt/homebrew/lib/docker/cli-plugins',
          '/usr/local/lib/docker/cli-plugins',
          '/usr/libexec/docker/cli-plugins',
          '/usr/lib/docker/cli-plugins',
          
          // win32
          ...(process.env.USERPROFILE ? [ `${process.env.USERPROFILE}/.docker/cli-plugins` ] : []),
          ...(process.env.ProgramFiles ? [ `${process.env.ProgramFiles}/Docker/Docker/resources/cli-plugins` ] : []),
          ...(process.env.ProgramData ? [ `${process.env.ProgramData}/Docker/cli-plugins` ] : []),
          'C:/Program Files/Docker/Docker/resources/cli-plugins',
          'C:/ProgramData/Docker/cli-plugins'
          
        ].map(str => str.replace(/[\\]/g, '/')));
        
        return Promise[cl.allArr](possibleFps[cl.toArr](async fp => {
          const kids = await rootFact.kid([ fp ]).getKids();
          return kids[cl.empty]() ? cl.skip : fp;
        }));
        
      })();
      logger.log({ dockerPluginDirs });
      
      try {
        
        // Populate docker build files
        await Promise.all([
          
          dockerOpsFact.kid([ 'config.json' ]).setData(JSON.stringify({
            
            auths: { [registryAddr]: { auth: ecrAuth.token } },
            ...(dockerPluginDirs.length && { cliPluginsExtraDirs: dockerPluginDirs })
            
          }, null, 2)),
          
          dockerOpsFact.kid([ 'Dockerfile' ]).setData(String[cl.baseline](`
            | FROM public.ecr.aws/docker/library/node:24-alpine
            | RUN apk add --no-cache openssl
            | WORKDIR /
            | COPY platformer.cjs /platformer.cjs
            | CMD ["node", "/platformer.cjs"]
          `)),
          
          dockerOpsFact.kid([ 'buildContext', 'platformer.cjs' ]).setData(packedCode),
            
        ]);
        
        await logger.scope('dockerBuildxCreate', {}, logger => proc(`docker buildx create --name {{builder}} --driver docker-container --bootstrap --use`, {
          inp: { builder: dockerBuilderId },
          env: dockerEnv,
          timeoutMs: Infinity,
          bufferOutput: false,
          // onData: async (type, data) => (data && logger.log({ data }), null)
        }));
        
        await logger.scope('dockerBuildxBuild', {}, logger => proc(`docker buildx build --builder {{dockerBuilderId}} --platform linux/amd64 --load -t {{ref}} -f {{dockerfile}} {{buildContext}}`, {
          inp: {
            dockerBuilderId,
            ref: `${repoUrl}:hash-${hash}`,
            dockerfile:   dockerOpsFact.kid([ 'Dockerfile'   ]).fsp(),
            buildContext: dockerOpsFact.kid([ 'buildContext' ]).fsp()
          },
          env: dockerEnv,
          timeoutMs: Infinity,
          bufferOutput: false,
          // onData: async (type, data) => (data && logger.log({ data }), null)
        }));
        
        await logger.scope('dockerPush', {}, logger => proc(`docker push {{ref}}`, {
          inp: { ref: `${repoUrl}:hash-${hash}` },
          env: dockerEnv,
          timeoutMs: Infinity,
          bufferOutput: false,
          // onData: async (type, data) => (data && logger.log({ data }), null)
        }));
        
        await logger.scope('dockerTagLatest', {}, async logger => {
          
          await proc(`docker tag {{ref}} {{latestRef}}`, {
            // `docker tag` simply creates an alias tag for an existing tag
            inp: {
              ref: `${repoUrl}:hash-${hash}`,
              latestRef: `${repoUrl}:latest`
            },
            env: dockerEnv,
            timeoutMs: Infinity
          });
          logger.log({ $$: 'tag' });
  
          await proc(`docker push {{ref}}`, {
            inp: { ref: `${repoUrl}:latest` },
            env: dockerEnv,
            timeoutMs: Infinity,
          });
          logger.log({ $$: 'push' });
          
        });
        
      } finally {
        
        await logger.scope('dockerBuildxFinish', {}, logger => proc(`docker buildx rm {{dockerBuilderId}}`, {
          inp: { dockerBuilderId },
          env: dockerEnv,
          timeoutMs: Infinity,
        }).catch(() => logger.log({ $$: 'dockerBuildxBuilderCleanupReject', dockerBuilderId })));
        
        await dockerOpsFact.rem();
        
      }
      
    }));
    
    for (const { lbd: lambda, mode } of this.pistils) {
      
      const rolePetal = await lambda.getPetals().then(p => p.find(p => p.getType() === 'awsIamRole')!);
      const lambdaPolicyName = phrasing('parts->camel', [ 'lambdaPlatformer', lambda.getName(), this.name ]);
      const fx = {
        accept: phrasing('camel->kamel', 'allow'),
        reject: phrasing('camel->kamel', 'deny')
      };
      
      const tfp = (pt: PetalTerraform.Base, prop: string) => tf.embed(pt.refStr(prop));
      const taskArn = `arn:aws:ecs:${this.region}:*:task/${flowerName}/*`;
      const hostedZoneArn = 'arn:aws:route53:::hostedzone/*';
      // const dnsRecordNames = this.domain ? [ `*.${this.domain.getAddrBase()}`, `_acme-challenge.${this.domain.getAddrBase()}` ] : [];
      
      const statements = [
        
        { effect: fx.accept, resource: [ '*'                             ], action: [ 'ec2:DescribeNetworkInterfaces'                           ] },
        { effect: fx.accept, resource: [ tfp(ecsCluster, 'arn')          ], action: [ 'ecs:DescribeClusters',         'ecs:ListTasks'           ] },
        { effect: fx.accept, resource: [ tfp(ecsCluster, 'arn'), taskArn ], action: [ 'ecs:DescribeTasks',            'ecs:ListTagsForResource' ] },
        
        ...!this.domain ? [] : [
          { effect: fx.accept, resource: [ '*'           ], action: [ 'route53:ListHostedZonesByName'  ] },
          { effect: fx.accept, resource: [ hostedZoneArn ], action: [ 'route53:ListResourceRecordSets' ] }
        ],
        
        ...![ 'write', 'admin' ][cl.has](mode) ? [] : [
          
          { effect: fx.accept, resource: [ tfp(taskDefinition, 'arn'), tfp(ecsCluster, 'arn') ], action: [ 'ecs:RunTask'                     ] },
          { effect: fx.accept, resource: [ taskArn                                            ], action: [ 'ecs:StopTask', 'ecs:TagResource' ] },
          { effect: fx.accept, resource: [ tfp(taskExecRole, 'arn')                           ], action: [ 'iam:PassRole'                    ], condition: { stringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } },
          
          ...!this.domain ? [] : [
            // Consider: this condition narrows the ChangeResourceRecordSets permission: `condition: { forAllValues: { stringLike: { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': dnsRecordNames } }, stringEquals: { 'route53:ChangeResourceRecordSetsRecordTypes': [ 'A', 'TXT' ] } }`
            { effect: fx.accept, resource: [ hostedZoneArn                ], action: [ 'route53:ChangeResourceRecordSets' ] },
            { effect: fx.accept, resource: [ 'arn:aws:route53:::change/*' ], action: [ 'route53:GetChange'                ] }
          ],
          
        ],
        
        ...![ 'admin' ][cl.has](mode) ? [] : [
          { effect: fx.accept, resource: [ tfp(ecsCluster, 'arn') ], action: [ 'ecs:TagResource' ] }
        ]
        
      ];
      const lambdaPolicy = new PetalTerraform.Resource('awsIamPolicy', lambdaPolicyName, {
        name: `${this.garden.pfx}-${lambdaPolicyName}`,
        policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: statements }))
      });
      yield lambdaPolicy;
      
      yield new PetalTerraform.Resource('awsIamRolePolicyAttachment', lambdaPolicyName, {
        role:      rolePetal.ref('name'),
        policyArn: lambdaPolicy.ref('arn')
      });
      
    }
    
    // An output to populate the service map
    type ResolvedTf = {
      vpcId: string,
      publicSubnetIds: string[],
      securityGroupId: string,
    };
    const outTf = {
      vpcId: vpc.ref('id'),
      publicSubnetIds: `| [ for subnet in ${publicSubnets.refStr()} : subnet.id ]`,
      securityGroupId: securityGroup.ref('id')
    };
    yield new Output(handle([ 'network' ]), outTf, (inp: ResolvedTf) => ({ serviceMap: {
      [this.getFlowerId() satisfies keyof ServiceMap.AwsFargateMap]: {
        subnetIds: inp.publicSubnetIds,
        securityGroupId: inp.securityGroupId
      }
    } satisfies ServiceMap.AwsFargateMap}));
    
    // An output to cover terraform's inability to destroy clusters with active tasks
    yield new Output(handle([ 'cleanup' ]), {}, () => ({ cleanup: {
      [this.getFlowerId()]: logger => logger.scope('killPlatforms', {}, async logger => {
        
        await this.addPollen().cancel({ logger });
        
      })
    }}));
    
  }
  
  public addPollen(inp?: { client?: { mode: 'view' | 'mark' | 'keep', lbd: AnyLambda }, undici?: UndiciUtils }) {
    
    const { client = null, undici = null } = inp ?? {};
    if (client) this.pistils.push(client);
    
    return new PollenPlatformer({
      
      ...(this.domain ? { dns: {
        configFact: this.certFact ?? this.garden.infraFact.kid([ 'cert' ]),
        rootHost: this.domain.getAddrBase(),
        letsEncrypt: { directory: 'm2', email: 'test@test.com' }
      }} : {}),
      
      ...(undici ? { undici } : {}),
      
      garden: this.garden,
      flowerId: this.getFlowerId()
      
    });
    
  }
  
};
