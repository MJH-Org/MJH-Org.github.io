import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('.');
const docsDir = resolve(root, 'docs');

await rm(docsDir, { recursive: true, force: true });
await mkdir(docsDir, { recursive: true });

await cp(resolve(root, 'frontend/index.html'), resolve(docsDir, 'index.html'));
await cp(resolve(root, 'frontend/bank.html'), resolve(docsDir, 'bank.html'));
await cp(resolve(root, 'frontend/source.html'), resolve(docsDir, 'source.html'));
await cp(resolve(root, 'frontend/app.js'), resolve(docsDir, 'app.js'));
await cp(resolve(root, 'frontend/styles.css'), resolve(docsDir, 'styles.css'));
await cp(resolve(root, 'server/data'), resolve(docsDir, 'data'), { recursive: true });
await writeFile(resolve(docsDir, '.nojekyll'), '', 'utf8');

await cp(resolve(docsDir, 'index.html'), resolve(root, 'index.html'));
await cp(resolve(docsDir, 'bank.html'), resolve(root, 'bank.html'));
await cp(resolve(docsDir, 'source.html'), resolve(root, 'source.html'));
await cp(resolve(docsDir, 'app.js'), resolve(root, 'app.js'));
await cp(resolve(docsDir, 'styles.css'), resolve(root, 'styles.css'));
await cp(resolve(docsDir, '.nojekyll'), resolve(root, '.nojekyll'));
await rm(resolve(root, 'data'), { recursive: true, force: true });
await cp(resolve(docsDir, 'data'), resolve(root, 'data'), { recursive: true });

console.log('Built GitHub Pages site in docs/');
