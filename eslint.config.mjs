import obsidianmd from "eslint-plugin-obsidianmd";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    plugins: { obsidianmd },
    languageOptions: { parser: tsParser },
    rules: { "obsidianmd/ui/sentence-case": ["error", { enforceCamelCaseLower: true }] },
  },
];
