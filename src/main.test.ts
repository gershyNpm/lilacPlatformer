import '@gershy/clearing';
import { assertEqual, cmpAny, cmpFn, cmpReg, testRunner }                           from '../build/utils.test.ts';
import { Platformer }                                                               from './main/platformer.ts';
import tracked                                                                      from './util/tracked.ts';
import { entry }                                                                    from '@gershy/entry';
import { Garden }                                                                   from '@gershy/lilac';
import { rootFact }                                                                 from '@gershy/disk';
import { gardenAwsTest }                                                            from './garden.test.ts';
import { Domain }                                                                   from '@gershy/lilac-domain';
import { fetch as undiciFetch, Agent as UndiciAgent, WebSocket as UndiciWebSocket } from 'undici';

const codec = { type: 'rec', props: {
  reg:    { type: 'str', map: (str: string) => new RegExp(str) },
  effort: { type: 'enum', opts: [ 0, 1, 2, 3, 4, 5, 6 ] },
  aws:    { req: false, type: 'rec', props: {
    region: { type: 'str' },
    auth: { type: 'rec', props: {
      id: { type: 'str' },
      '!secret': { type: 'str' },
    }}
  }},
  preserveGarden: { req: false, type: 'bln' },
  manual: { req: false, type: 'rec', props: {
    ownedAddr:            { type: 'str', map: (str: string) => str as `${string}.${string}` },
    nameServersConnected: { type: 'bln' }
  }}
}} as const;
const log = { format: {
  objDepth: 7,
  maxLineLen: 130,
  maxStrLen: 300
}};
entry({ name: 'lilacPlatformer', codec, log, inp: { reg: '^', effort: 0, preserveGarden: false }, fn: async (logger, { reg, effort, preserveGarden, manual = null, ...inp }) => {
  
  // Type testing
  (async () => {
    
    type Enforce<Provided, Expected extends Provided> = { provided: Provided, expected: Expected };
    
    type Tests = {
      1: Enforce<{ x: 'y' }, { x: 'y' }>,
    };
    if (0) ((v?: Tests) => void 0)();
    
  })();
  
  const testFact = rootFact.kid([ import.meta.dirname, '.test' ]);
  await testRunner({ logger, reg, effort, inp, cases: [
    
    gardenAwsTest({ name: 'platformer domain no', testFact, preserveGarden, effort: 3,
      
      makeGarden: (props) => new Garden({ ...props, seedBank: { Platformer }, survey: ({ Platformer }, add) => {
        
        const platformer = add(new Platformer({
          name: 'testSubject',
          baseUrl: import.meta.url,
          power: 0,
          localData: { desc: 'my local data' },
          launchFn: async v => v.localData,
          invokeFn: async ({ launchData, session, inp }) => {
            
            const msg = { echo: inp, utcMs: Date.now(), launchData };
            await session.send({ ...msg, sokt: 1 });
            await session.send({ ...msg, sokt: 2 });
            await session.send({ ...msg, sokt: 3 });
            
            return msg;
            
          }
        }));
        
        return {
          name: platformer.getFlowerId().split('/').at(-1)!,
          platformerPollen: platformer.addPollen({
            undici: { fetch: undiciFetch, Agent: UndiciAgent, WebSocket: UndiciWebSocket }
          })
        };
        
      }}),
      
      testAttempts: 1, 
      testGarden: async ({ logger, platformerPollen }) => tracked(async trk => {
        
        const platform = await platformerPollen.platformLaunch({ logger });
        logger.log({ $$: 'testtt', platform });
        
        trk(() => platformerPollen.platformCancel({ logger, platform }));
        assertEqual(platform, {
          task: {
            id: [ cmpReg, /^arn:aws:ecs:ca-central-1:[0-9]{12}:task[/][a-zA-Z0-9]+-test-subject[/][a-z0-9]+$/ ],
            utcMs: [ cmpFn, v => cl.isCls(v, Number) ],
            status: cmpAny,
            eni: { id: [ cmpReg, /^eni-[a-z0-9]+$/ ] },
            tags: cmpAny,
            stopped: null
          },
          '!adminPass': cmpAny,
          ipHost: [ cmpReg, /[0-9]{1,3}([.][0-9]{1,3}){3}/ ],
          dnsHost: null
        });
        
        const session = await platformerPollen.platformSessionLaunch({ logger, platform });
        trk(() => session.cancel({ logger }));
        
        const reply = await session.tell({ logger, reply: true, msg: [ 'hello' ] });
        logger.log({ $$: 'send' });
        
        await new Promise(r => setTimeout(r, 500));
        
        await session.cancel({ logger });
        logger.log({ $$: 'rake' });
        
        const notices = await session.hear()[cl.toArr](v => v);
        logger.log({ $$: 'results', reply, notices });
        
        assertEqual({ reply, notices }, {
          reply: { echo: [ 'hello' ], utcMs: [ cmpFn, v => cl.isCls(v, Number) ], launchData: { desc: 'my local data' } },
          notices: [
            { echo: [ 'hello' ], utcMs: [ cmpFn, v => cl.isCls(v, Number) ], launchData: { desc: 'my local data' }, sokt: 1 },
            { echo: [ 'hello' ], utcMs: [ cmpFn, v => cl.isCls(v, Number) ], launchData: { desc: 'my local data' }, sokt: 2 },
            { echo: [ 'hello' ], utcMs: [ cmpFn, v => cl.isCls(v, Number) ], launchData: { desc: 'my local data' }, sokt: 3 }
          ]
        });
        
      })
      
    }),
    
    gardenAwsTest({ name: 'platformer domain ya', effort: 5, testFact, preserveGarden, opts: { manual },
      
      makeGarden: ({ opts, ...props }) => new Garden({ ...props, seedBank: { Domain, Platformer }, survey: ({ Domain, Platformer }, add) => {
        
        if (!opts.manual) throw Error('manual options missing');
        
        const domain = add(new Domain({
          addr: opts.manual.ownedAddr,
          manualConfirmations: { nameServersConnected: opts.manual.nameServersConnected }
        }));
        
        const platformer = add(new Platformer({
          domain,
          certFact:  rootFact.kid([ import.meta.dirname ]).par(2).kid([ '.manager', 'dev', 'cert' ]),
          name:      'testSubject',
          baseUrl:   import.meta.url,
          power:     0,
          localData: { desc: 'my local data' },
          launchFn: async v => v.localData,
          invokeFn: async ({ launchData, session, inp }) => {
            
            if (cl.isCls(inp, Object) && inp[cl.at]('x') === 'x') {
              await session.send({ xxx: 'xxx', sokt: 999 });
              return null;
            }
            
            const msg = { echo: inp, utcMs: Date.now(), launchData };
            await session.send({ ...msg, sokt: 1 });
            await session.send({ ...msg, sokt: 2 });
            await session.send({ ...msg, sokt: 3 });
            
            return msg;
            
          }
        }));
        
        return {
          name: platformer.getFlowerId().split('/').at(-1)!,
          platformer: platformer.addPollen()
        };
        
      }}),
      testGardenError: async ({ logger, garden, err, opts }) => {
        
        if (!opts.manual) throw Error('manual options missing');
        
        // If we've manually set name servers and an error still occurs, it's a fatal error
        if (opts.manual.nameServersConnected) throw err;
        
        // An error occurred, but name servers haven't been set: validate the error appropriately
        // directs the user to manually configure name servers
        assertEqual(err, Error('requirements unsatisfied')[cl.mod]({
          
          rake: [ cmpFn, v => cl.inCls(v, Function) ],
          manualRequirements: {
            [`domain/${opts.manual.ownedAddr}`]: [ cmpReg, /The domain "[^"]+" has been declared but it is not yet servable[.]/ ]
          }
          
        }));
        
        const reqText = err.manualRequirements[`domain/${opts.manual.ownedAddr}`] as string;
        const nameServers = reqText.match(/add the following name servers: ([^\n,]+)/)![1].split(' and ');
        
        logger.log({ $$: 'manualRequirements', manualRequirements: err.manualRequirements, nameServers });
        
      },
      
      testAttempts: 5, // Allowing several retries is a good idea as dns propagation can mess with this test... 
      testGarden: async ({ logger, platformer, opts }) => tracked(async trk => { // TODO: Add `tracked` here...
        
        Error[cl.assert](opts, opts => !!opts.manual);
        
        const platform = await platformer.platformLaunch({ logger });
        trk(() => platformer.platformCancel({ logger, platform }));
        
        const session = await platformer.platformSessionLaunch({ logger, platform });
        const sessionCancel = trk(async () => session.cancel({ logger }));
        
        await session.tell({ logger, reply: false, msg: { x: 'x' } });
        await new Promise(r => setTimeout(r, 500));
        
        const reply = await session.tell({ logger, reply: true, msg: [ 'hello' ] });
        await new Promise(r => setTimeout(r, 500));
        logger.log({ $$: 'send' });
        
        await sessionCancel.launch();
        
        const notices = await session.hear()[cl.toArr](v => v);
        logger.log({ $$: 'results', reply, notices });
        
        assertEqual({ reply, notices }, {
          reply: { echo: [ 'hello' ], utcMs: [ cmpFn, v => cl.isCls(v, Number) ], launchData: { desc: 'my local data' } },
          notices: [
            { xxx: 'xxx', sokt: 999 },
            { echo: [ 'hello' ], utcMs: [ cmpFn, v => cl.isCls(v, Number) ], launchData: { desc: 'my local data' }, sokt: 1 },
            { echo: [ 'hello' ], utcMs: [ cmpFn, v => cl.isCls(v, Number) ], launchData: { desc: 'my local data' }, sokt: 2 },
            { echo: [ 'hello' ], utcMs: [ cmpFn, v => cl.isCls(v, Number) ], launchData: { desc: 'my local data' }, sokt: 3 }
          ]
        });
        
      })
      
    })
    
  ]});
  
}});