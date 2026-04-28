import os from "node:os";
import { randomUUID } from "node:crypto";
import { db } from "./memory.js";
import { migrate, TaskQueue } from "./taskQueue.js";

migrate(db);

// Single per-process worker ID. If this process forks or cluster.spawn()s,
// generate a new WORKER_ID per child — sharing one breaks the lease guards
// that match worker_id on every state-changing UPDATE.
export const WORKER_ID = `${os.hostname()}:${process.pid}:${randomUUID()}`;

export const taskQueue = new TaskQueue(db);
