// TODO: move to @gershy/util-funnel
export default async function*<T>(gens: AsyncIterator<T>[]) {
  
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