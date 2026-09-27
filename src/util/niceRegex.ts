// TODO: Create and move this into @gershy/util-nice-regex

export default ((...args: string[] /* flags, niceRegexStr | niceRegexStr */) => {
  
  // Allows writing self-documenting regular expressions
  
  const { skip } = cl;
  const map:   typeof cl.map   = cl.map;
  const toArr: typeof cl.toArr = cl.toArr;
  const rem:   typeof cl.rem   = cl.rem;
  const mod:   typeof cl.mod   = cl.mod;
  
  const [ flags, str ] = (args.length === 2) ? args : [ 'u', args[0] ];
  const lns = str.split('\n')[map](line => line.trimEnd());
  
  const maxColLen = Math.max(...lns[map](line => line.length));
  const cols = maxColLen[toArr](col => new Set( lns[map](ln => ln[col] ?? skip) ));
  for (const col of cols) if (col.size > 1) col[rem](' ');
  
  for (const [ colNum, charSet ] of cols.entries())
    if (charSet.size > 1)
      throw Error(`conflicting chars`)[mod]({ str: `\n${str}\n`, col: colNum, chars: [ ...charSet ] });
  
  return RegExp(cols[map](col => [ ...col ][0]).join(''), flags);
  
}) as {
  (               str: string): RegExp,
  (flags: string, str: string): RegExp
};