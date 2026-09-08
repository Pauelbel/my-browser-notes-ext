import {build} from 'esbuild';
import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
await build({entryPoints:['editor-source.js'],bundle:true,format:'esm',outfile:'vendor/editor.js',minify:true,legalComments:'linked',target:'chrome122'});
const notices = [];
for (const entry of await readdir('node_modules/.pnpm')) {
  const base = path.join('node_modules/.pnpm',entry,'node_modules');
  let children; try {children = await readdir(base);} catch {continue;}
  for (const name of children) {
    const packages = name.startsWith('@') ? (await readdir(path.join(base,name))).map(n => path.join(base,name,n)) : [path.join(base,name)];
    for (const dir of packages) {
      try {
        const pkg = JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
        if (notices.some(n => n.name === pkg.name)) continue;
        const file = (await readdir(dir)).find(f => /^license(?:\.(?:md|txt))?$/i.test(f));
        if (file) notices.push({name:pkg.name,text:`${pkg.name} ${pkg.version}\n${await readFile(path.join(dir,file),'utf8')}`});
      } catch {}
    }
  }
}
await writeFile('vendor/THIRD_PARTY_NOTICES.txt',notices.map(n => n.text).join('\n\n--------------------\n\n'));
