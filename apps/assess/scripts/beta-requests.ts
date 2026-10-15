/**
 * Who pressed 「申请内测」 on their result page, oldest first, for sending Crossline invitations by hand. Reads the test's own SQLite
 * file (`ASSESS_DATA_DIR`, default `apps/assess/data`); writes nothing. A request goes with its result, so anyone not invited within
 * the 90-day retention drops off the list.
 *
 *   pnpm --filter @crossline/assess exec tsx scripts/beta-requests.ts
 */
import { TYPE_TABLE } from "@crossline/core/assess";
import { listBetaRequests } from "../server/store";

const rows = listBetaRequests();
for (const row of rows) console.log([row.requestedAt.slice(0, 16).replace("T", " "), row.email, row.nickname || "-", `${TYPE_TABLE[row.code]?.name ?? ""} ${row.code}`].join("\t"));
console.log(`${rows.length} 人申请`);
