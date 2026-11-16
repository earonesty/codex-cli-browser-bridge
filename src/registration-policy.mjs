/** Self-contained: the patcher embeds this function in the desktop handler.
 * A lease registers a session; it is not a browser authorization grant. The
 * original account/Work-policy check runs after this returns an executor ID.
 */
export function resolveRegisteredCliExecutor(request, { instanceId, principal, root, now = Date.now(), procRoot = "/proc" }) {
  try {
    if (process.platform !== "linux" || !principal?.accountId || !principal?.userId) return undefined;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request.sessionId)) return undefined;
    if (request.executorId !== JSON.stringify([instanceId, "native-browser-plugin"])) return undefined;
    const fs = process.getBuiltinModule("node:fs");
    const path = process.getBuiltinModule("node:path");
    const crypto = process.getBuiltinModule("node:crypto");
    const uid = process.getuid();
    const dir = fs.lstatSync(root);
    if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0) return undefined;
    function readPrivateJson(name) {
      const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > 16384) throw new Error("Invalid CLI browser registration file");
        return JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally { fs.closeSync(fd); }
    }
    const policy = readPrivateJson("policy.json");
    if (policy.version !== 1 || policy.enabled !== true || policy.accountId !== principal.accountId || policy.userId !== principal.userId) return undefined;
    const lease = readPrivateJson(`${request.sessionId}.json`);
    if (lease.version !== 1 || lease.sessionId !== request.sessionId || lease.desktopInstanceId !== instanceId
      || lease.accountId !== principal.accountId || lease.userId !== principal.userId
      || !Number.isSafeInteger(lease.pid) || lease.pid <= 0
      || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now || lease.expiresAt > now + 6 * 60 * 60 * 1000
      || typeof lease.startTicks !== "string") return undefined;
    const processDir = path.join(procRoot, String(lease.pid));
    const status = fs.readFileSync(path.join(processDir, "status"), "utf8");
    const owners = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (!owners || owners.slice(1).some((owner) => Number(owner) !== uid)) return undefined;
    const stat = fs.readFileSync(path.join(processDir, "stat"), "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] !== lease.startTicks) return undefined;
    const executable = fs.realpathSync(path.join(processDir, "exe"));
    const approved = policy.executables?.find((entry) => entry.path === executable);
    if (!approved || !/^[0-9a-f]{64}$/.test(approved.sha256)) return undefined;
    const binary = fs.statSync(executable);
    if (!binary.isFile() || (binary.mode & 0o022) !== 0) return undefined;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
    if (hash !== approved.sha256) return undefined;
    // Check again after hashing to reject a process that exited or changed identity.
    const after = fs.readFileSync(path.join(processDir, "stat"), "utf8");
    if (after.slice(after.lastIndexOf(")") + 2).split(/\s+/)[19] !== lease.startTicks
      || fs.realpathSync(path.join(processDir, "exe")) !== executable) return undefined;
    return JSON.stringify([instanceId, principal.accountId, principal.userId]);
  } catch {
    return undefined;
  }
}
