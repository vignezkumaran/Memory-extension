import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const watchMode = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: [
    'src/background/index.ts',
    'src/content/chatgpt/index.ts',
    'src/content/claude/index.ts',
    'src/content/perplexity/index.ts',
    'src/popup/popup.tsx'
  ],
  outdir: 'dist/src',
  outbase: 'src',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120', 'firefox120', 'edge120'],
  sourcemap: true,
  logLevel: 'info'
};

async function copyStaticFiles() {
  await mkdir(path.join(distDir, 'src/popup'), { recursive: true });
  await cp(path.join(rootDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  await cp(path.join(rootDir, 'src/popup/popup.html'), path.join(distDir, 'src/popup/popup.html'));
}

async function cleanDist() {
  await rm(distDir, { recursive: true, force: true });
}

async function runBuild() {
  await cleanDist();

  if (watchMode) {
    const ctx = await context(buildOptions);
    await ctx.watch();
    await ctx.rebuild();
    await copyStaticFiles();
    console.info('Watching for changes...');
    return;
  }

  await build(buildOptions);
  await copyStaticFiles();
  console.info('Build completed in dist/.');
}

runBuild().catch((error) => {
  console.error(error);
  process.exit(1);
});
