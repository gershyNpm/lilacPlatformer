import '@gershy/clearing';
import Logger from '@gershy/logger';

const { isCls, inCls, getCls, getClsName } = clearing;
const count: typeof cl.count = cl.count;
const toArr: typeof cl.toArr = cl.toArr;
const has:   typeof cl.has   = cl.has;
const mod:   typeof cl.mod   = cl.mod;

export const cmpAny        = Symbol('@gershy/test/cmp/any');
export const cmpReg        = Symbol('@gershy/test/cmp/reg');
export const cmpJson       = Symbol('@gershy/test/cmp/json');
export const cmpPartialObj = Symbol('@gershy/test/cmp/partialObj');
export const cmpFn         = Symbol('@gershy/test/cmp/fn');

export const equal = (v0: any, v1: any, path: (string | number)[] = []): { equal: true } | { equal: false, path: (string | number)[], [K: string]: any } => {
  
  if (v0 === v1)                      return { equal: true };
  if (v0 == null || v1 == null)       return { equal: false, path, reason: 'identity', v0, v1 };
  
  // Process direct marker symbols
  if (v1 === cmpAny) return { equal: true };
  
  // Validate for string matching regex: `[ cmpReg, /must match th(is|at)/ ]`
  if (v1[0] === cmpReg) {
    
    if (!isCls(v0, String)) return { equal: false, path, reason: 'nonstring', cls0: getCls(v0) };
    
    const reg = v1[1] as RegExp;
    return reg.test(v0)
      ? { equal: true }
      : { equal: false, path, reason: 'regex', regex: `/${reg.source}/`, str: v0 };
    
  }
  
  if (v1[0] === cmpPartialObj) {
    
    if (!isCls(v0, Object)) return { equal: false, path, reason: 'nonobject', cls0: getCls(v0) };
    
    const p1 = v1[1] as Obj<any>;
    const p0 = v0[cl.slice](p1[cl.toArr]((v, k) => k));
    return equal(p0, p1, [ ...path, '<partial>' ]);
    
  }
  
  // Process tuples whose first item is a marker symbol
  if (v1[0] === cmpJson) {
    
    if (!isCls(v0, String)) return { equal: false, path, reason: 'nonstring', cls0: getCls(v0) };
    
    const parsed = (() => {
      try         { return JSON.parse(v0); }
      catch (err) { return { equal: false, path, reason: 'nonjson', v0 }; }
    })();
    
    return equal(parsed, v1[1], [ ...path, '<json>' ]);
    
  }
  
  // Validate using an arbitrary function: `[ cmpFn, (val: any) => boolean ]`
  if (v1[0] === cmpFn) {
    
    const result: boolean = v1[1](v0);
    return result
      ? { equal: true }
      : { equal: false, path, reason: 'fn', fn: v1[1].toString().replace(/\s+/g, ' ') };
    
  }
  
  const cls0 = getCls(v0);
  const cls1 = getCls(v1);
  
  if (cls0 !== cls1)    return { equal: false, path, reason: 'class', cls0: getClsName(v0), cls1: getClsName(v1) };
  if (cls0 === Number)  return { equal: false, path, reason: 'identity', v0, v1 };
  if (cls0 === Boolean) return { equal: false, path, reason: 'identity', v0, v1 };
  
  if (cls0 === String)  {
    
    let mismatchInd = 0;
    while (v0[mismatchInd] === v1[mismatchInd]) mismatchInd++;
    if (v0.length > 100 || v1.length > 100) {
      
      [ v0, v1 ] = [ v0, v1 ].map(v => {
        
        return [
          v.slice(0, mismatchInd),
          `<MISMATCH>${v[mismatchInd] ?? '[eof]'}</MISMATCH>`,
          v.slice(mismatchInd + 1)
        ].join('');
        
      });
      
    }
    
    return { equal: false, path, reason: 'identity', mismatchInd, v0, v1 };
    
  }
  
  if (cls0 === Array) {
    
    const len0 = v0[count]();
    const len1 = v1[count]();
    if (len0 !== len1) return { equal: false, path, reason: 'arr size', len0, len1 };
    
    for (let i = 0; i < len0; i++) {
      const eq = equal(v0[i], v1[i], [ ...path, i ]);
      if (!eq.equal) return eq;
    }
    
    return { equal: true };
    
  }
  
  if (cls0 === Object) {
    
    const keys0 = v0[toArr]((v, k) => k).sort();
    const keys1 = v1[toArr]((v, k) => k).sort();
    if (!equal(keys0, keys1).equal) return { equal: false, path, reason: 'obj keys', keys0, keys1 };
    
    for (const k in v0) {
      if (!v1[has](k)) return { equal: false, path: [ ...path, k ], reason: 'obj key', key: k, obj0: 'present', obj1: 'absent' } ;
      
      const eq = equal(v0[k], v1[k], [ ...path, k ]);
      if (!eq.equal) return eq;
      
    }
    return { equal: true };
    
  }
  
  if (cls0 === Set) {
    
    if (v0.size !== v1.size) return { equal: false, path, reason: 'set size', len0: v0.size, len1: v1.size };
    for (const v of v0)
      if (!v1.has(v))
        return { equal: false, path, reason: 'set inclusion', val: v, set0: 'present', set1: 'absent' };
    
    return { equal: true };
    
  }
  
  if (cls0 === Map) {
    
    if (v0.size !== v1.size) return { equal: false, path, reason: 'map size', len0: v0.size, len1: v1.size };
    
    for (const [ k, v ] of v0) {
      if (!v1.has(k)) return { equal: false, path: [ ...path, k ], reason: 'map key', key: k, map0: 'present', map1: 'absent' };
      
      const eq = equal(v, v1.get(k), [ ...path, k ]);
      if (!eq.equal) return eq;
    }
    
    return { equal: true };
    
  }
  
  if (cls0 === ArrayBuffer) return equal([ ...new Uint8Array(v0) ], [ ...new Uint8Array(v1) ], [ ...path, '<number[]>' ])
  
  if (ArrayBuffer.isView(v0)) return equal(
    v0.buffer.slice(v0.byteOffset, v0.byteOffset + v0.byteLength),
    v1.buffer.slice(v1.byteOffset, v1.byteOffset + v1.byteLength),
    [ ...path, '<arrayBuffer>' ]
  );
  
  if (inCls(v0, Error)) {
    // Include message, but not stack (because it's a nightmare to define expected stacktrace
    // values when defining expected results)
    return equal({ $msg: v0.message, ...v0 }, { $msg: v1.message, ...v1 }, [ ...path, '<obj>' ]);
  }
  
  if (inCls(v0, Function)) {
    
    return equal(
      v0.toString().replace(/\s+/g, ' '),
      v1.toString().replace(/\s+/g, ' '),
      [ ...path, '<str>' ]
    );
    
  }
  
  return { equal: false, path, reason: 'unknown comparison', cls: getClsName(v0) };
  
};
export const assertEqual = (v0: any, v1: any) => {
  
  const { equal: eq, ...props } = equal(v0, v1);
  
  if (!eq) throw Error('assert equal')[mod]({ ...props });
  
};
type Effort = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type TestRunnerInp<Inp> = {
  logger?: Logger,
  reg?: RegExp,
  effort?: Effort,
  inp: Inp,
  cases: { name: string, effort?: Effort, fn: (logger: Logger, inp: Inp) => Promise<void> }[]
};
export const testRunner = async <Inp = null>(inp: TestRunnerInp<Inp>) => {
  
  const logger = inp.logger ?? Logger.dummy;
  const reg = inp.reg ?? /^/;
  const effort = inp.effort ?? 0;
  const testInp = (inp.inp ?? null) as Inp;
  
  const { cases } = inp;
  // const cases = inp.cases.filter(c => reg.test(c.name) && (c.effort ?? 0) <= effort);
  // const num = cases.length;
  // const tot = inp.cases.length;
  await logger.scope('tests', { effort, reg: `/${reg.source}/` }, async logger => {
    
    let numRan = 0;
    for (const [ n, c ] of cases.entries()) await logger.scope(n.toString(), { name: c.name, effort: c.effort ?? 0 }, async logger => {
      
      if (!reg.test(c.name))        { logger.log({ $$: 'skipped', reg: `/${reg.source}/` }); return; }
      if ((c.effort ?? 0) > effort) { logger.log({ $$: 'skipped', maxEffort: effort });      return; }
      
      numRan++;
      await c.fn(logger, testInp);
      
    });
    
    logger.log({ $$: 'result', invokedTests: numRan, totalTests: cases.length, time: (new Date()).toISOString().split(/[T.]/)[1] });
    
  });
  
};
