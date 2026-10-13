/** Process lifecycle flags shared by the health endpoints and the shutdown handler. */
let shuttingDown = false;
export const isShuttingDown = () => shuttingDown;
export const beginShutdown = () => {
  shuttingDown = true;
};
/** Tests only. */
export const resetLifecycleForTests = () => {
  shuttingDown = false;
};
