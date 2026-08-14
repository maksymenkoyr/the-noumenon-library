import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // next/core-web-vitals only pulls in a partial jsx-a11y subset (alt-text,
  // aria-props, aria-proptypes, ...). The full recommended set adds
  // label-has-associated-control, click-events-have-key-events,
  // no-static-element-interactions, anchor-is-valid, and more. Only the
  // `rules` are merged in, not `plugins` — eslint-config-next already
  // registers the same jsx-a11y plugin (same 6.10.2 install) under that
  // key, and flat config errors ("Cannot redefine plugin") if two configs
  // both try to register a plugin under one name.
  { rules: jsxA11y.flatConfigs.recommended.rules },
  {
    rules: {
      // Underscore-prefixed args are intentionally unused placeholders.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Obsidian vault internals (third-party plugin bundles), not app code.
    "docs/.obsidian/**",
  ]),
]);

export default eslintConfig;
