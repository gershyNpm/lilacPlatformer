import type { JsImport } from '@gershy/util-jsfn-encode';
import slashEscape from '@gershy/util-slash-escape';

export const mergeJsImports = (jsImports: JsImport[]) => {
  
  // Note merging fails if:
  // - The same variable name is used by different importers to reference different values (no
  //   good name available for these global refs!)
  // 
  // Note some "apparent" failure cases can be accomodated:
  // - The same import reappearing, named differently - create aliases
  //      | 
  //      | import name1, { name2 } from 'module';
  //      | const name3 = name1;
  //      | const name4 = name2;
  //      | 
  
  const merged: Obj<{ full: string[], named: Obj<string[]> }> = {};
  
  for (const ji of jsImports) {
    
    const varDef = ji.varDef?.trim() ?? null;
    const importPath = ji.importPath.trim();
    
    const imp = merged[importPath] ??= { full: [], named: {} };
    if (!varDef) continue;
    
    if (varDef[0] !== '{') { imp.full.push(varDef); continue; }
    
    for (const ent of varDef.slice(1, -1).split(',')) {
      const [ k, v = k ] = ent[cl.cut](':', 1);
      (imp.named[k] ??= []).push(v);
    }
    
  }
  
  return merged[cl.map](({ full, named }) => ({
    
    full: [ ...new Set(full) ],
    named: named[cl.map](ents => [ ...new Set(ents) ])
    
  }));
  
};
export const getImports = (args: { mergedImports: ReturnType<typeof mergeJsImports>, lang: 'js' | 'ts' }) => {
  
  const imports: string[] = [];
  
  if (args.lang === 'js') {
    
    for (const [ importPath, { full, named } ] of args.mergedImports[cl.walk]()) {
      
      const hasFull = !full[cl.empty]();
      const hasNamed = !named[cl.empty]();
      const importStr = `'${slashEscape(importPath, `'`)}'`;
      
      if (!hasFull && !hasNamed) {
        imports.push(`require(${importStr});`);
        continue;
      }
      
      if (hasFull) {
        
        const [ v, ...more ] = full;
        imports.push(...[
          `const ${v} = require(${importStr});`,
          ...more.map(m => `const ${m} = ${v};`)
        ]);
        
      }
      
      if (hasNamed) {
        
        // Note `import { x as a, x as b, x as c } from './thingy.ts'` is legal typescript!
        // Note `const { x: a, x: b, x: c } = require('./thingy.ts')` is legal javascript!
        
        imports.push(`const { ${
          named
            [cl.toArr]((aliases, k) => aliases.map(a => a !== k ? `${k}: ${a}` : k))
            .flat(1)
        } } = require(${importStr});`);
        
      }
      
    }
    
  } else if (args.lang === 'ts') {
    
    for (const [ importPath, { full, named } ] of args.mergedImports[cl.walk]()) {
      
      const hasFull = !full[cl.empty]();
      const hasNamed = !named[cl.empty]();
      const importStr = `'${slashEscape(importPath, `'`)}'`;
      
      if (!hasFull && !hasNamed) {
        imports.push(`import ${importStr};`);
        continue;
      }
      
      if (hasFull) {
        
        const [ v, ...more ] = full;
        imports.push(...[
          `import ${v} from ${importStr};`,
          ...more.map(m => `const ${m} = ${v};`)
        ]);
        
      }
      
      if (hasNamed) {
        
        // Note `import { x as a, x as b, x as c } from './thingy.ts'` is legal typescript!
        // Note `const { x: a, x: b, x: c } = require('./thingy.ts')` is legal javascript!
        
        imports.push(`import { ${
          named
            [cl.toArr]((aliases, k) => aliases.map(a => a !== k ? `${k} as ${a}` : k))
            .flat(1)
        } } from ${importStr};`);
        
      }
      
    }
    
  }
  
  return imports;
  
};