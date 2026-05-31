import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["node_modules/**", "out/**", "dist/**", ".vscode-test/**"]
    },
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
            parserOptions: {
                project: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": "warn",
            "no-const-assign": "warn",
            "no-undef": "off", // TS handles this
        },
    }
);
