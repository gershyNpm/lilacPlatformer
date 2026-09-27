// TODO: Flower definers (Lilac consumers) will want to use these - make sure they're well-exposed

export const embed = (v: string) => '${' + v + '}';
export const json = (v: Json) => [
  '| <<EOF',
  JSON.stringify(v, null, 2)[cl.indent](2),
  'EOF'
].join('\n');

export const provider = (defaultAwsRegion: string, targetAwsRegion: string): { $provider: string } => {
  
  // Takes a default region and target region, and returns the terraform properties needed to set
  // a petal's region to the target region - note if the target region is the default region, no
  // properties are needed!
  
  return defaultAwsRegion !== targetAwsRegion
    ? { $provider: `aws.${targetAwsRegion.split('-').join('_')}` }
    : {} as any;
  
}