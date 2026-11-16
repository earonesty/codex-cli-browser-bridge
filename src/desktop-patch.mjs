import { resolveRegisteredCliExecutor } from "./registration-policy.mjs";

const ANCHOR = 'async readLocalWorkBrowserAccess(e){let t=e.executorId===i4?await this.nativeBrowserThreadAccess.getExecutorId(e.sessionId):e.executorId;if(null==t)return!1;let r=this.appServerConnectionRegistry.getConnection(sp.n),n=';
const MARKER = "/* codex-cli-browser-registration:v1 */";

export function patchDesktopSource(source) {
  if (source.includes(MARKER)) throw new Error("Desktop CLI browser registration patch is already present");
  if (source.split(ANCHOR).length !== 2) throw new Error("Unsupported desktop build: authorization handler anchor did not match exactly once");
  const helper = resolveRegisteredCliExecutor.toString().replace(/^function resolveRegisteredCliExecutor/, "function");
  const replacement = 'async readLocalWorkBrowserAccess(e){' + MARKER
    + 'let r=this.appServerConnectionRegistry.getConnection(sp.n),t=e.executorId===i4?await this.nativeBrowserThreadAccess.getExecutorId(e.sessionId):e.executorId;'
    + `if(null==t&&e.executorId===i4)t=(${helper})(e,{instanceId:i9.P,principal:r.getCachedAuthenticatedPrincipal(),root:process.getBuiltinModule("node:path").join(process.env.CODEX_HOME||process.getBuiltinModule("node:path").join(process.getBuiltinModule("node:os").homedir(),".codex"),"browser","cli-registration")});`
    + 'if(null==t)return!1;let n=';
  return source.replace(ANCHOR, replacement);
}

export const desktopPatchMarker = MARKER;
