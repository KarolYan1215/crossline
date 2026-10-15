/**
 * What kind of material a file is, from its name: how it is drawn (Markdown, a Word or PDF document, a table, an image, plain text) or
 * whether it is shown at all. Code, configuration and caches are the assistant's scaffolding, not material, and stay out of every list.
 */
export type MaterialKind = "markdown" | "docx" | "pdf" | "csv" | "image" | "text" | "office" | "other";

const EXT = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

export function materialKind(name: string): MaterialKind {
  const ext = EXT(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (ext === "txt" || ext === "log") return "text";
  if (["doc", "pptx", "ppt", "xlsx", "xls", "odt", "ods", "odp"].includes(ext)) return "office";
  return "other";
}

/** Scripts, data formats and folders a run works in: never listed as material. */
const TOOLING_EXT = /\.(py|pyc|pyo|ipynb|js|mjs|cjs|ts|tsx|jsx|ps1|psm1|sh|bat|cmd|json|ya?ml|toml|ini|cfg|conf|lock|env|map|tmp|h|hpp|c|cc|cpp|rs|go|java|rst|sample|sha256|zip|yapf)$/i;
const TOOLING_DIR = /(^|[\\/])(__pycache__|node_modules|\.git|\.venv|venv|scripts|\.cache|tests?)([\\/]|$)/i;
const README = /(^|[\\/])readme(\.[a-z]+)?$/i;
export const isTooling = (path: string) => TOOLING_EXT.test(path) || TOOLING_DIR.test(path) || README.test(path) || /(^|[\\/])(SKILL\.md|audit\.json)$/i.test(path);

/** The same file route with one query parameter set (`view=preview`, `download=1`), whether or not it already has a query. */
export function withQuery(src: string, key: string, value: string): string {
  const [base, hash = ""] = src.split("#");
  const separator = base!.includes("?") ? "&" : "?";
  return `${base}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash ? `#${hash}` : ""}`;
}

/** The material page for one of the file routes: `/materials/view?src=…&name=…`. */
export const viewerHref = (src: string, name: string) => `/materials/view?src=${encodeURIComponent(src)}&name=${encodeURIComponent(name)}`;

export const KIND_LABEL: Record<MaterialKind, string> = {
  markdown: "文档", docx: "Word 文档", pdf: "PDF", csv: "表格", image: "图片", text: "文本", office: "Office 文件", other: "文件"
};
