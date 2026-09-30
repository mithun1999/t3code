import type { languages } from "monaco-editor/editor/editor.api.js";

type LanguageConfiguration = languages.LanguageConfiguration;

/**
 * Editing rules (comments, brackets, auto-closing, indentation) for Shiki's
 * grammars. Shiki carries only grammars, so the rules come from Monaco's own
 * language definitions; Monaco's tokenizers are never used for colour.
 */
const DEFINITION_LOADERS = {
  clojure: () => import("monaco-editor/languages/definitions/clojure/clojure.js"),
  cpp: () => import("monaco-editor/languages/definitions/cpp/cpp.js"),
  csharp: () => import("monaco-editor/languages/definitions/csharp/csharp.js"),
  css: () => import("monaco-editor/languages/definitions/css/css.js"),
  dart: () => import("monaco-editor/languages/definitions/dart/dart.js"),
  dockerfile: () => import("monaco-editor/languages/definitions/dockerfile/dockerfile.js"),
  elixir: () => import("monaco-editor/languages/definitions/elixir/elixir.js"),
  go: () => import("monaco-editor/languages/definitions/go/go.js"),
  graphql: () => import("monaco-editor/languages/definitions/graphql/graphql.js"),
  handlebars: () => import("monaco-editor/languages/definitions/handlebars/handlebars.js"),
  hcl: () => import("monaco-editor/languages/definitions/hcl/hcl.js"),
  html: () => import("monaco-editor/languages/definitions/html/html.js"),
  ini: () => import("monaco-editor/languages/definitions/ini/ini.js"),
  java: () => import("monaco-editor/languages/definitions/java/java.js"),
  javascript: () => import("monaco-editor/languages/definitions/javascript/javascript.js"),
  julia: () => import("monaco-editor/languages/definitions/julia/julia.js"),
  kotlin: () => import("monaco-editor/languages/definitions/kotlin/kotlin.js"),
  less: () => import("monaco-editor/languages/definitions/less/less.js"),
  lua: () => import("monaco-editor/languages/definitions/lua/lua.js"),
  markdown: () => import("monaco-editor/languages/definitions/markdown/markdown.js"),
  perl: () => import("monaco-editor/languages/definitions/perl/perl.js"),
  php: () => import("monaco-editor/languages/definitions/php/php.js"),
  powershell: () => import("monaco-editor/languages/definitions/powershell/powershell.js"),
  protobuf: () => import("monaco-editor/languages/definitions/protobuf/protobuf.js"),
  pug: () => import("monaco-editor/languages/definitions/pug/pug.js"),
  python: () => import("monaco-editor/languages/definitions/python/python.js"),
  r: () => import("monaco-editor/languages/definitions/r/r.js"),
  ruby: () => import("monaco-editor/languages/definitions/ruby/ruby.js"),
  rust: () => import("monaco-editor/languages/definitions/rust/rust.js"),
  scala: () => import("monaco-editor/languages/definitions/scala/scala.js"),
  scss: () => import("monaco-editor/languages/definitions/scss/scss.js"),
  shell: () => import("monaco-editor/languages/definitions/shell/shell.js"),
  sql: () => import("monaco-editor/languages/definitions/sql/sql.js"),
  swift: () => import("monaco-editor/languages/definitions/swift/swift.js"),
  typescript: () => import("monaco-editor/languages/definitions/typescript/typescript.js"),
  xml: () => import("monaco-editor/languages/definitions/xml/xml.js"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/yaml.js"),
} satisfies Record<string, () => Promise<{ conf: LanguageConfiguration }>>;

type DefinitionName = keyof typeof DEFINITION_LOADERS;

/** Shiki language ids whose editing rules match a Monaco definition. */
const DEFINITION_BY_LANGUAGE: Readonly<Record<string, DefinitionName>> = {
  astro: "html",
  bash: "shell",
  c: "cpp",
  clojure: "clojure",
  cpp: "cpp",
  csharp: "csharp",
  css: "css",
  cts: "typescript",
  dart: "dart",
  docker: "dockerfile",
  dockerfile: "dockerfile",
  elixir: "elixir",
  fish: "shell",
  go: "go",
  graphql: "graphql",
  handlebars: "handlebars",
  hcl: "hcl",
  html: "html",
  ini: "ini",
  java: "java",
  javascript: "javascript",
  jinja: "html",
  jsx: "javascript",
  julia: "julia",
  kotlin: "kotlin",
  less: "less",
  lua: "lua",
  make: "shell",
  makefile: "shell",
  markdown: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  objc: "cpp",
  "objective-c": "cpp",
  perl: "perl",
  php: "php",
  postcss: "css",
  powershell: "powershell",
  properties: "ini",
  proto: "protobuf",
  pug: "pug",
  python: "python",
  r: "r",
  ruby: "ruby",
  rust: "rust",
  sass: "scss",
  scala: "scala",
  scss: "scss",
  sh: "shell",
  shellscript: "shell",
  sql: "sql",
  svelte: "html",
  swift: "swift",
  terraform: "hcl",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

const JSON_CONFIGURATION: LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}", notIn: ["string"] },
    { open: "[", close: "]", notIn: ["string"] },
    { open: '"', close: '"', notIn: ["string"] },
  ],
};

const HASH_COMMENT_LANGUAGES = new Set(["dotenv", "gitignore", "ignore", "requirements", "nginx"]);

/** Brackets and quotes only, for grammars without a matching definition. */
function genericConfiguration(language: string): LanguageConfiguration {
  return {
    ...(HASH_COMMENT_LANGUAGES.has(language) ? { comments: { lineComment: "#" } } : {}),
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string", "comment"] },
    ],
  };
}

/** Where the editing rules for a Shiki language come from. */
export function languageConfigurationSource(
  language: string,
): { kind: "definition"; name: DefinitionName } | { kind: "json" } | { kind: "generic" } {
  if (language === "json" || language === "jsonc" || language === "json5") return { kind: "json" };
  const name = DEFINITION_BY_LANGUAGE[language];
  return name === undefined ? { kind: "generic" } : { kind: "definition", name };
}

export async function loadLanguageConfiguration(language: string): Promise<LanguageConfiguration> {
  const source = languageConfigurationSource(language);
  if (source.kind === "json") return JSON_CONFIGURATION;
  if (source.kind === "generic") return genericConfiguration(language);
  try {
    return (await DEFINITION_LOADERS[source.name]()).conf;
  } catch {
    return genericConfiguration(language);
  }
}
