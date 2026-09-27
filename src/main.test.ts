import { testRunner } from '../build/utils.test.ts';
import './main.ts';
import { entry } from '@gershy/entry';
import '@gershy/clearing';

const codec = { type: 'rec', props: {
  reg:    { type: 'str', map: (str: string) => new RegExp(str) },
  effort: { type: 'enum', opts: [ 0, 1, 2, 3, 4, 5, 6 ] }
}} as const;
entry({ name: 'test', codec, inp: { reg: '^', effort: 0 }, fn: async (logger, { reg, effort, ...inp }) => {
  
  // Type testing
  (async () => {
    
    type Enforce<Provided, Expected extends Provided> = { provided: Provided, expected: Expected };
    
    type Tests = {
      1: Enforce<{ x: 'y' }, { x: 'y' }>,
    };
    if (0) ((v?: Tests) => void 0)();
    
  })();
  
  await testRunner({ logger, reg, effort, inp, cases: [
    
    { name: 'todo', fn: async logger => {
      logger.log({ $$: 'threat', msg: 'TODO - implement!' });
    }}
  
  ]});
  
}});