import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('.');
const docsDir = resolve(root, 'docs');

await rm(docsDir, { recursive: true, force: true });
await mkdir(docsDir, { recursive: true });

await cp(resolve(root, 'frontend/index.html'), resolve(docsDir, 'index.html'));
await cp(resolve(root, 'frontend/bank.html'), resolve(docsDir, 'bank.html'));
await cp(resolve(root, 'frontend/app.js'), resolve(docsDir, 'app.js'));
await cp(resolve(root, 'frontend/styles.css'), resolve(docsDir, 'styles.css'));
await cp(resolve(root, 'server/data'), resolve(docsDir, 'data'), { recursive: true });
await writeFile(resolve(docsDir, '.nojekyll'), '', 'utf8');

console.log('Built GitHub Pages site in docs/');
