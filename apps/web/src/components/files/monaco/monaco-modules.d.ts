// Monaco's ESM build ships types only for its public entry. These are the
// internal modules the Files panel loads directly.

declare module "monaco-editor/features/register.all.js";

declare module "monaco-editor/languages/definitions/*" {
  import type { languages } from "monaco-editor/editor/editor.api.js";
  export const conf: languages.LanguageConfiguration;
}
