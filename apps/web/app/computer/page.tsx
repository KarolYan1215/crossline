import { requireSessionContext } from "../../lib/access-guard";
import { tOf } from "../../lib/locale";
import { SubpageShell } from "../subpage-shell";
import { ComputerRemote } from "./computer-remote";
import "./computer.css";

export const dynamic = "force-dynamic";

/**
 * 「遥控电脑」 (docs/plans/remote-control-1122.md): the person's own computer from their phone — a session with the assistant on it, a
 * direct command, its authorised folders, a free registration form waiting for 提交. Everything that makes the computer act is signed in
 * this phone's browser and checked on the computer; offline, the page shows the record and nothing waits to run.
 */
export default async function ComputerPage() {
  const ctx = await requireSessionContext();
  const t = tOf(ctx);
  // `active` names the view in the frame's own table, not shown text.
  return <SubpageShell title={t("遥控电脑")} active={"设置"} description={t("电脑开着时，从手机在这台电脑上工作；每件事都由这部手机签名，电脑自己核对。")}>
    <ComputerRemote />
  </SubpageShell>;
}
