/**
 * The mailbox against a real IMAP server (Dovecot on this machine): connect with the same code the worker uses, read new mail, read
 * one in full, search, sort it through the triage path, and check that nothing on the server changed. Usage:
 *   pnpm exec tsx scripts/mail-imap-e2e.ts <host-name> <port> <address> <password> <maildir>
 * The connection goes to 127.0.0.1 with the certificate unchecked (a test server's self-signed one); everything else is the real path.
 */
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { CrosslineStore } from "../packages/db/src/index";
import type { ImapFactory } from "../packages/connectors/src/imap-mail";
import { addMailAccount, mailLookupFor, readNewMail, triageMail, MAIL_TRIAGE_SKILL } from "../apps/worker/src/mailbox";
import { fakeRuntime } from "../apps/worker/src/testing/fake-runtime";

// imapflow is the connectors package's dependency; the script takes it from there.
const { ImapFlow } = createRequire(new URL("../packages/connectors/package.json", import.meta.url))("imapflow") as typeof import("imapflow");
const [host = "imap.crossline-test.example", portText = "993", address = "", password = "", maildir = ""] = process.argv.slice(2);
const store = new CrosslineStore(":memory:");
const workspaceId = store.createPrincipalWithWorkspace("mail-e2e", "邮箱检验").workspace.id;
const kept = new Map<string, string>();
const secrets = { read: async (ws: string, name: string) => kept.get(`${ws}/${name}`), write: async (ws: string, name: string, value: string) => { kept.set(`${ws}/${name}`, value); },
  remove: (ws: string, name: string) => { kept.delete(`${ws}/${name}`); } };
const factory: ImapFactory = (options) => new ImapFlow({ ...options, host: "127.0.0.1", tls: { ...(options.tls ?? {}), rejectUnauthorized: false } });
const deps = { store, secrets, factory, resolve: async () => "203.0.113.10" };
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, info = "") => { results.push([name, ok, info]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  — ${info}` : ""}`); };
const flags = () => readdirSync(path.join(maildir, "cur")).concat(readdirSync(path.join(maildir, "new"))).map((name) => name.split(":2,")[1] ?? "");

const wrong = await addMailAccount(deps, workspaceId, { address, password: "wrong-code", host, port: Number(portText) });
check("错误授权码被拒绝且说清原因", !wrong.ok && wrong.code === "MAIL_AUTH_FAILED", JSON.stringify(wrong));
const added = await addMailAccount(deps, workspaceId, { address, password, host, port: Number(portText) });
check("正确授权码接入成功", added.ok, JSON.stringify(added).slice(0, 160));
check("授权码只在密钥库，不在账本", ![...JSON.stringify(store.exportSnapshot())].join("").includes(password) && kept.size === 1);

const before = flags();
const fresh = await readNewMail(deps, workspaceId, true);
check("首次读到全部 3 封", fresh.length === 3, fresh.map((m) => m.subject).join(" | "));
check("编码的中文主题被解码", fresh.some((m) => m.subject.includes("图表方案")), fresh.map((m) => m.subject).join(" | "));
check("中文正文开头可读", fresh.some((m) => m.snippet.includes("第二版")));
check("HTML 邮件只留文字", fresh.some((m) => m.snippet.includes("Everything half price") && !m.snippet.includes("<")));
check("服务器上邮件标志未变（只读）", JSON.stringify(flags().sort()) === JSON.stringify(before.sort()) && !flags().some((f) => f.includes("S")), JSON.stringify(flags()));
check("再读不重复", (await readNewMail(deps, workspaceId, true)).length === 0);

writeFileSync(path.join(maildir, "new", `${Date.now()}.4.test`), `From: TA <ta@uni.edu>\r\nTo: ${address}\r\nSubject: Office hours moved\r\nDate: Mon, 19 Oct 2026 11:00:00 +0000\r\n\r\nOffice hours move to Thursday 3pm this week.\r\n`);
const fourth = await readNewMail(deps, workspaceId, true);
check("新来一封只读到这一封", fourth.length === 1 && fourth[0]!.subject === "Office hours moved", fourth.map((m) => m.subject).join(" | "));

const lookup = mailLookupFor(deps, workspaceId)!;
const hits = await lookup.search({ text: "HW3", sinceDays: 30 });
check("助手搜索按主题找到", hits.length === 1 && hits[0]!.subject.includes("HW3"), JSON.stringify(hits).slice(0, 200));
const full = hits[0] ? await lookup.read(hits[0].id) : undefined;
check("助手读全文", Boolean(full?.text.includes("Submit on Canvas")), (full?.text ?? "").slice(0, 120));

const all = [...fresh, ...fourth];
const hw = all.find((m) => m.subject.includes("HW3"))!;
const answer = JSON.stringify({ items: all.map((m, index) => ({ uid: index + 1, kind: m === hw ? "todo" : "info", title: m === hw ? "STAT 610 HW3（11/4 23:59 截止，Canvas 提交）" : "", waitingId: "", why: "" })) });
const { rpc } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
const sorted = await triageMail({ ...deps, client: rpc, cwd: process.cwd() }, workspaceId, all);
check("分类后待办进收件箱", sorted.state === "done" && store.listCaptures(workspaceId).some((c) => c.title.includes("HW3")), JSON.stringify(sorted));
console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} 通过`);
store.close();
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
