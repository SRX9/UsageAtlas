import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/.vite/**", "**/out/**", "**/dist/**", "**/coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["forge.config.cjs"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly"
      }
    },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }]
    }
  },
  {
    // Vendored Dither Kit components — kept byte-identical to the registry so
    // they update cleanly. Their context modules intentionally export hooks
    // alongside providers, which only trips the dev-only fast-refresh rule.
    files: ["src/renderer/components/dither-kit/**/*.{ts,tsx}"],
    rules: { "react-refresh/only-export-components": "off" }
  }
);
