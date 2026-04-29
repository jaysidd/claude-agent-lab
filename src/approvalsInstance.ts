// Bootstrap singleton for Approvals. Mirrors taskQueueInstance.ts /
// costGuardInstance.ts / schedulerInstance.ts. Runs the migration and the
// boot-time orphan sweep so the kanban doesn't show ghost approvals from
// previous server processes.

import { db } from "./memory.js";
import { migrate, Approvals } from "./approvals.js";
import { WORKER_ID } from "./taskQueueInstance.js";

migrate(db);

export const approvals = new Approvals(db);

// Sweep approvals from previous server processes — their in-memory waiters
// are gone, the agent runs they guarded are dead. Idempotent. Logged so the
// operator sees the cleanup count on boot.
const sweep = approvals.expireOrphaned(WORKER_ID);
if (sweep.swept > 0) {
  console.log(
    `[approvals] expired ${sweep.swept} orphaned approval${sweep.swept === 1 ? "" : "s"} from prior server process`,
  );
}
