import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/** eslint-config-next 16 ships flat configs, so no FlatCompat layer is needed. */
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "data/**",
      "coverage/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
      "scripts/dev/**",
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // 服务端代码常用下划线前缀表示“有意忽略”的解构字段（如 objectKey）。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];

export default config;
