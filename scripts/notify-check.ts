/**
 * Shows one Crossline desktop notification on this machine, to see that toasts arrive and that clicking one
 * opens the app. Writes nothing anywhere.
 *
 *   pnpm exec tsx scripts/notify-check.ts
 */
import { showToast } from "../apps/worker/src/notify.js";

const shown = await showToast("Crossline 通知测试", "能看到这条，说明桌面通知可用；点它会打开今日页。", "http://127.0.0.1:3210/");
console.log(shown ? "已发出一条桌面通知。" : "没能发出通知（不是 Windows，或 PowerShell 调用失败）。");
process.exit(shown ? 0 : 1);
