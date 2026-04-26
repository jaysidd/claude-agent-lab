import os from "node:os";
import { randomUUID } from "node:crypto";
import { db } from "./memory.js";
import { migrate, TaskQueue } from "./taskQueue.js";

migrate(db);

export const WORKER_ID = `${os.hostname()}:${process.pid}:${randomUUID()}`;

export const taskQueue = new TaskQueue(db);
