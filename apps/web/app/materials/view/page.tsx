import { notFound } from "next/navigation";
import { SubpageShell } from "../../subpage-shell";
import { requireSessionContext } from "../../../lib/access-guard";
import { gateUntilReady } from "../../../lib/start-gate";
import { getStore } from "../../../lib/crossline";
import { MaterialViewer } from "../material-viewer";
import { fileDigest } from "../material-digest";
import { localeFor } from "../../../lib/locale";
import { intlLocale, tFor } from "../../../lib/i18n";

export const dynamic = "force-dynamic";

/** Only the app's own file routes are drawn here; the route itself checks the file belongs to the viewer's workspace. */
const ROUTES = [
  /^\/api\/source-documents\/([A-Za-z0-9_-]{1,128})\/file$/,
  /^\/api\/agent\/tasks\/[A-Za-z0-9_.:-]{1,160}\/file\?path=[^#]{1,600}$/,
  /^\/api\/work-orders\/[A-Za-z0-9_-]{1,128}\/materials\?uri=[^#]{1,1200}$/
];

/**
 * A material opened on its own (a link to an assistant's file, a person's upload, a tutorial's kept copy): drawn by the material viewer
 * instead of handed to the browser, which showed Markdown as raw text and saved a Word file under the name 「file」. The file routes send
 * a browser here when it opens them as a page. `?from=/workbench/<id>` adds the way back to the task.
 */
export default async function MaterialViewPage({ searchParams }: { searchParams: Promise<{ src?: string; name?: string; from?: string }> }) {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const { src = "", name = "", from } = await searchParams;
  if (!ROUTES.some((route) => route.test(src))) notFound();
  const fileName = name.replace(/[\r\n]/g, " ").slice(0, 200) || t("材料");
  const docId = ROUTES[0]!.exec(src)?.[1];
  const document = docId ? getStore().listSourceDocuments(ctx.workspaceId).find((item) => item.id === docId) : undefined;
  if (docId && !document) notFound();
  const digest = document ? fileDigest({ fileName: document.fileName, extractedText: document.extractedText, notes: [], steps: [], units: [] }) : undefined;
  const project = document?.projectId ? getStore().listProjects(ctx.workspaceId, { includeArchived: true }).find((item) => item.id === document.projectId)?.name : undefined;
  const back = from && /^\/workbench\/[A-Za-z0-9_-]{1,128}$/.test(from) ? from : undefined;
  const aside = digest && <div className="mt-digest">
    <h2>{t("这份材料")}</h2>
    <p className="mt-digest-kind"><span className="tag">{t("本人上传")}</span>
      <small>{t(digest.kindLabel)}{digest.characters ? t(" · 约 {{chars}} 字", { chars: digest.characters.toLocaleString(intlLocale(locale)) }) : ""}{project ? ` · ${project}` : ""}</small></p>
    {digest.sections.length > 0 && <><h3>{t("包含")}</h3><ul className="mt-digest-sections">{digest.sections.map((section) => <li key={section}>{section}</li>)}</ul></>}
  </div>;
  return <SubpageShell active={"任务"} title={document?.fileName ?? fileName.split(/[\\/]/).pop() ?? fileName}>
    {back && <p className="material-back"><a href={back}>{t("← 回到任务")}</a></p>}
    <MaterialViewer src={src} name={document?.fileName ?? fileName} generated={!document} size="page" {...(aside ? { aside } : {})} />
  </SubpageShell>;
}
