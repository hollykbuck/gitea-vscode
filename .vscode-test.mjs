import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'test/**/*.test.ts',
    mocha: {
        ui: 'tdd',
        timeout: 20000
    }
});
