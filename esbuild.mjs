import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'], // Always exclude vscode module
    format: 'cjs',        // VS Code extensions use CommonJS
    platform: 'node',
    target: 'node18',    // Match VS Code's Node.js version
    sourcemap: !isProduction,
    minify: isProduction,
    logLevel: 'info',
};

async function run() {
    if (isWatch) {
        const ctx = await context(buildOptions);
        await ctx.watch();
    } else {
        await build(buildOptions);
    }
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
