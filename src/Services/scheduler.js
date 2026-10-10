// Periodic housekeeping (stands in for Redis/BullMQ workers at MVP scale):
// quote expiry, proof reminders, closing delivered lines after the complaint window,
// and at-risk job escalation. Each task is idempotent so overlapping runs are harmless.
const { config } = require("../Config/env");

const tasks = [];

function register(name, fn, everyMs) {
  tasks.push({ name, fn, everyMs });
}

async function runTask(task) {
  try {
    await task.fn();
  } catch (error) {
    console.error(`[scheduler] ${task.name} failed: ${error.message}`);
  }
}

function start() {
  if (config.isTest || process.env.DISABLE_SCHEDULER === "true") return;
  // Load lazily to avoid circular imports at startup.
  require("./housekeeping").registerAll(register);
  for (const task of tasks) {
    setTimeout(() => runTask(task), 5_000).unref();
    setInterval(() => runTask(task), task.everyMs).unref();
  }
}

async function runAllOnce() {
  if (!tasks.length) require("./housekeeping").registerAll(register);
  for (const task of tasks) await runTask(task);
}

module.exports = { start, runAllOnce };
