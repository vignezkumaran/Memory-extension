import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing required file: ${path}`);
  }
}

try {
  run('npm run typecheck');
  run('npm run build');

  const requiredFiles = [
    'dist/src/background/index.js',
    'dist/src/popup/popup.js',
    'dist/src/popup/popup.css',
    'dist/src/content/chatgpt/index.js',
    'dist/src/content/claude/index.js',
    'dist/src/content/perplexity/index.js',
    'dist/src/content/deepseek/index.js',
    'manifest.json'
  ];

  for (const file of requiredFiles) {
    assertFile(file);
  }

  console.log('\nRelease check passed: typecheck, build, and required artifacts verified.');
} catch (error) {
  console.error('\nRelease check failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
