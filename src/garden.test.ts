import phrasing from '@gershy/util-phrasing';
import { tempFact, type Fact } from '@gershy/disk';
import { Soil, type Garden } from '@gershy/lilac';
import retry from '@gershy/util-retry';
import type Logger from '@gershy/logger';

export type GardenProps = {
  logger: Logger,
  term: string,
  infraFact: Fact,
  patioFact: Fact,
  shedFact: Fact,
  debug: boolean,
  pfx: string
};
export const gardenAwsTest = <Opts, Orn>(inp: {
  name:             string,
  testFact:         Fact,
  effort:           0 | 1 | 2 | 3 | 4 | 5 | 6,
  testAttempts?:    number,
  opts?:            Opts,
  makeGarden:       (props: GardenProps & { opts: Opts }) => Garden<any, Orn>,
  testGardenError?: (inp: { logger: Logger, garden: Garden<any, Orn>, rake: null | (() => Promise<void>), err: any, opts: Opts }) => Promise<void>,
  testGarden:       (orn: Orn & { logger: Logger, garden: Garden<any, Orn>, opts: Opts }) => Promise<void>,
  preserveGarden?: boolean
}) => {
  
  const { name, testFact, effort, testAttempts = 5, makeGarden, testGarden, opts = null, testGardenError = null, preserveGarden = false } = inp;
  
  if ( !((v: unknown): v is Opts => true)(opts) ) throw Error('ouch');
  
  return { name, effort, fn: async (logger: Logger, inp: any) => {
    
    if (!inp.aws) return void logger.log({ $$: 'skipped', aws: null });
    
    const term = phrasing('parts->camel', [ 'lilac', ...name.split(' ') ]);
    const gardenFact = testFact.kid([ term ]);
    const garden = await makeGarden({
      logger,
      term,
      debug:     true,
      infraFact: gardenFact.kid([ 'terraform' ]),
      patioFact: gardenFact.kid([ 'patio' ]),
      shedFact:  tempFact.kid([ '@gershy' ]),
      pfx:       term[cl.lower](),
      opts
    });
    
    let rake: null | (() => Promise<void>) = null;
    
    try {
      
      const growResult = await logger.scope('grow', {}, async logger => {
        
        const soil = new Soil.AwsCloud({ logger, garden, auth: inp.aws.auth });
        const { ornaments, rake } = await garden.grow(soil);
        return { ornaments, rake };
        
      }).then(
        grown => ({ success: true as const, grown }),
        err => ({ success: false as const, err })
      );
      
      if (growResult.success) {
        
        rake = growResult.grown.rake;
        await logger.scope('test', {}, logger => retry({
          attempts: testAttempts,
          retry: () => true,
          delayMs: n => Math.min(250 * n, 5 * 1000), // Successively longer delays; max delay is 5sec
          fn: num => {
            logger.log({ $$: 'attempt', num });
            return testGarden({ ...growResult.grown.ornaments, logger, garden, opts });
          }
        }));
        
      } else {
        
        if (!testGardenError) throw growResult.err;
        
        // For manual tests with a grown-garden-across-phases:
        // - If an initial manual phase is successful (i.e. garden grows but fails due to requiring
        //   the appropriate manual action)
        
        await logger.scope('errorTest', {}, logger => {
          return testGardenError({ logger, garden, rake, err: growResult.err, opts });
        });
        
      }
      
    } catch (err: any) {
      
      rake ??= err.rake ?? null;
      throw err;
      
    } finally {
      
      if (!rake) { logger.log({ $$: 'rake.unavailable' }); return; }
      
      if (preserveGarden) { logger.log({ $$: 'rake.preserveGarden' }); return; }
        
      await rake().catch(err => {
        throw err[cl.mod](msg => ({ msg: `${msg} - aws deployment couldn't be removed; see tfFp`, tfFp: garden.infraFact.fsp() }));
      });
      await gardenFact.rem();
      
    }
    
  }};
  
};