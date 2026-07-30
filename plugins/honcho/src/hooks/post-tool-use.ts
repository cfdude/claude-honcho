import { Honcho } from "@honcho-ai/sdk";
import { loadConfig, getSessionForPath, getSessionName, getHonchoClientOptions, isPluginEnabled, getCachedStdin } from "../config.js";
import { appendClaudeWork, getClaudeInstanceId } from "../cache.js";
import { logHook, logApiCall, setLogContext } from "../log.js";
import { visCaptureWithError } from "../visual.js";
import { redactSecrets } from "../redact.js";


interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, any>;
  tool_response?: Record<string, any>;
  cwd?: string;
  workspace_roots?: string[];
}

function shouldLogTool(toolName: string, toolInput: Record<string, any>): boolean {
  const significantTools = new Set(["Write", "Edit", "Bash", "Task", "NotebookEdit"]);

  if (!significantTools.has(toolName)) {
    return false;
  }

  if (toolName === "Bash") {
    const command = toolInput.command || "";
    // Skip read-only / navigation commands that carry no memory signal.
    const trivialCommands = ["cd", "ls", "pwd", "echo", "cat", "head", "tail", "which", "type", "git status", "git log", "git diff"];
    if (trivialCommands.some((cmd) => command.trim().startsWith(cmd))) {
      return false;
    }
  }

  return true;
}

/**
 * Extract meaningful purpose/description from file content
 */
function inferContentPurpose(content: string, filePath: string): string {
  // Detect file type from extension
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  // For code files, try to extract the main export/function/class
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    // Look for main export
    const exportMatch = content.match(/export\s+(default\s+)?(function|class|const|interface|type)\s+(\w+)/);
    if (exportMatch) {
      return `defines ${exportMatch[2]} ${exportMatch[3]}`;
    }
    // Look for component
    const componentMatch = content.match(/(?:function|const)\s+(\w+).*(?:return|=>)\s*[(<]/);
    if (componentMatch) {
      return `component ${componentMatch[1]}`;
    }
  }

  // For Python
  if (ext === 'py') {
    const classMatch = content.match(/class\s+(\w+)/);
    const defMatch = content.match(/def\s+(\w+)/);
    if (classMatch) return `defines class ${classMatch[1]}`;
    if (defMatch) return `defines function ${defMatch[1]}`;
  }

  // For markdown/docs
  if (['md', 'mdx', 'txt'].includes(ext)) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    // Redact BEFORE slicing: a secret in the heading must not survive by
    // sitting past the truncation boundary, and slicing a raw secret can leave
    // a partially-visible fragment.
    if (headingMatch) return `doc: ${redactSecrets(headingMatch[1]).slice(0, 50)}`;
  }

  // For config files
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) {
    return 'config file';
  }

  // Fallback: line count
  const lineCount = content.split('\n').length;
  return `${lineCount} lines`;
}

/**
 * Summarize what changed in an edit (not just the raw strings)
 */
export function summarizeEdit(oldStr: string, newStr: string, filePath: string): string {
  const oldLines = oldStr.split('\n').length;
  const newLines = newStr.split('\n').length;

  // Detect type of change
  if (oldStr.trim() === '') {
    // Pure addition
    const purpose = inferContentPurpose(newStr, filePath);
    return `added ${newLines} lines (${purpose})`;
  }

  if (newStr.trim() === '') {
    // Deletion
    return `removed ${oldLines} lines`;
  }

  // Look for meaningful changes
  const oldTokens: string[] = oldStr.match(/\w+/g) ?? [];
  const newTokens: string[] = newStr.match(/\w+/g) ?? [];

  // Find added/removed identifiers.
  //
  // Set membership, not Array.includes. `newTokens.filter(t => !oldTokens.includes(t))`
  // is O(n·m) — a linear scan per token, done twice — which on a real 682 KB Edit
  // payload cost 12.6s, and never finished at all on a 100k-token edit. Measured:
  // 11.4s at 20k tokens/side and 40.1s at 40k, versus ~5ms and ~126ms here.
  // Output is byte-identical; this is purely the lookup structure.
  //
  // The cheap `t.length > 2` guard runs FIRST so short tokens skip the hash
  // lookup entirely — with `includes` the scan ran even for tokens that were
  // about to be discarded.
  const oldSet = new Set(oldTokens);
  const newSet = new Set(newTokens);
  const added = newTokens.filter(t => t.length > 2 && !oldSet.has(t));
  const removed = oldTokens.filter(t => t.length > 2 && !newSet.has(t));

  if (added.length > 0 && removed.length > 0) {
    return `changed: ${removed.slice(0, 2).join(', ')} → ${added.slice(0, 2).join(', ')}`;
  }
  if (added.length > 0) {
    return `added: ${added.slice(0, 3).join(', ')}`;
  }
  if (removed.length > 0) {
    return `removed: ${removed.slice(0, 3).join(', ')}`;
  }

  // Fallback
  const lineDiff = newLines - oldLines;
  if (lineDiff > 0) return `expanded by ${lineDiff} lines`;
  if (lineDiff < 0) return `reduced by ${-lineDiff} lines`;
  return `modified ${oldLines} lines`;
}

/**
 * Build the summary, then redact it. Upstream #81: this string is printed to the
 * terminal AND (with saveToolUse) uploaded to the Honcho server as durable
 * memory, so any secret in it leaks twice. Individual branches below redact
 * their own inputs first -- redaction must precede every `.slice()` -- and this
 * wrapper is the belt-and-braces second pass over the assembled line.
 * redactSecrets is idempotent, so the double application is safe.
 */
export function formatToolSummary(
  toolName: string,
  toolInput: Record<string, any>,
  toolResponse: Record<string, any>
): string {
  return redactSecrets(buildToolSummary(toolName, toolInput, toolResponse));
}

function buildToolSummary(
  toolName: string,
  toolInput: Record<string, any>,
  toolResponse: Record<string, any>
): string {
  switch (toolName) {
    case "Write": {
      const filePath = toolInput.file_path || "unknown";
      const content = toolInput.content || "";
      const purpose = inferContentPurpose(content, filePath);
      const fileName = filePath.split('/').pop() || filePath;
      return `Wrote ${fileName} (${purpose})`;
    }
    case "Edit": {
      const filePath = toolInput.file_path || "unknown";
      const fileName = filePath.split('/').pop() || filePath;
      // Redact before the diff runs: summarizeEdit reports raw identifiers it
      // found in the changed text, and a secret value would be reported verbatim.
      const oldStr = redactSecrets(toolInput.old_string || "");
      const newStr = redactSecrets(toolInput.new_string || "");
      const changeSummary = summarizeEdit(oldStr, newStr, filePath);
      return `Edited ${fileName}: ${changeSummary}`;
    }
    case "Bash": {
      // Redact BEFORE the 100-char slice (and the 60-char ones below), so a
      // secret past the boundary cannot survive and truncation cannot leave a
      // half-visible fragment.
      const command = redactSecrets(toolInput.command || "").slice(0, 100);
      const success = !toolResponse.error;
      // Extract meaningful command info
      const cmdParts = command.split(/[;&|]/)[0].trim();
      // Categorize command type
      if (['npm', 'pnpm', 'yarn', 'bun'].some(pm => command.includes(pm))) {
        const action = command.match(/(install|build|test|run|dev|start)/)?.[0] || 'command';
        return `Package ${action}: ${success ? 'success' : 'failed'}`;
      }
      if (command.includes('git commit')) {
        const msg = command.match(/-m\s*["']([^"']+)["']/)?.[1] || '';
        return `Git commit: ${msg.slice(0, 50)}${msg.length > 50 ? '...' : ''}`;
      }
      if (command.includes('git push')) {
        return `Git push: ${success ? 'success' : 'failed'}`;
      }
      if (['curl', 'wget', 'fetch'].some(c => command.includes(c))) {
        const url = command.match(/https?:\/\/[^\s"']+/)?.[0] || '';
        return `HTTP request to ${url.split('/')[2] || 'API'}: ${success ? 'success' : 'failed'}`;
      }
      if (command.includes('docker') || command.includes('flyctl') || command.includes('fly ')) {
        return `Deploy: ${cmdParts.slice(0, 60)} (${success ? 'success' : 'failed'})`;
      }
      return `Ran: ${cmdParts.slice(0, 60)} (${success ? "success" : "failed"})`;
    }
    case "Task": {
      const desc = toolInput.description || "unknown";
      const type = toolInput.subagent_type || "";
      return `Agent task (${type}): ${desc}`;
    }
    case "NotebookEdit": {
      const notebookPath = toolInput.notebook_path || "unknown";
      const fileName = notebookPath.split('/').pop() || notebookPath;
      const editMode = toolInput.edit_mode || "replace";
      const cellType = toolInput.cell_type || "code";
      return `Notebook ${editMode} ${cellType} cell in ${fileName}`;
    }
    default:
      return `Used ${toolName}`;
  }
}

/**
 * Three-valued outcome of the Honcho upload. Two values were not enough: the
 * old code wrapped logToHonchoAsync in `.then(() => null, e => …)`, so a SKIPPED
 * upload (saveMessages off / saveToolUse not opted in — the default) produced
 * exactly the same `null` as a delivered one, and the terminal printed
 * "captured: …" for every turn on a config that had uploaded nothing.
 */
type UploadOutcome =
  | { status: "uploaded" }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

/**
 * Upper bound on the awaited upload. Claude Code's own hook timeout was observed
 * never firing across 4,152 runs, so an unbounded await here can wedge a turn
 * indefinitely. 5s is deliberately close to (and no looser than) user-prompt's
 * 4000ms FETCH_TIMEOUT_MS: this is ONE session.addMessages POST rather than an
 * interactive fetch fan-out, so if it hasn't landed in 5s something is wrong and
 * saying so beats blocking the turn. On timeout we report a failure through the
 * same path as a real error, so it survives at "error" level.
 */
const UPLOAD_TIMEOUT_MS = 5000;

/**
 * Bound `p` with a timeout, mapping BOTH a rejection and a timeout onto the
 * error variant. Mirrors raceTimeout() in user-prompt.ts, but deliberately does
 * NOT collapse to `null`: null there is indistinguishable from "nothing was
 * requested", which is the exact confusion this hook is fixing. The timer is
 * cleared when the upload wins so nothing keeps the loop alive.
 */
async function withUploadTimeout(p: Promise<UploadOutcome>, ms: number): Promise<UploadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch((e): UploadOutcome => ({ status: "error", error: `capture upload failed: ${e}` })),
      new Promise<UploadOutcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "error", error: `capture upload timed out after ${ms}ms` }),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function handlePostToolUse(): Promise<void> {
  const hookStart = Date.now();
  const config = loadConfig();
  if (!config) {
    process.exit(0);
  }

  // Early exit if plugin is disabled
  if (!isPluginEnabled()) {
    process.exit(0);
  }

  let hookInput: HookInput = {};
  try {
    const input = getCachedStdin() ?? await Bun.stdin.text();
    if (input.trim()) {
      hookInput = JSON.parse(input);
    }
  } catch {
    process.exit(0);
  }

  const toolName = hookInput.tool_name || "";
  const toolInput = hookInput.tool_input || {};
  const toolResponse = hookInput.tool_response || {};
  const cwd = hookInput.workspace_roots?.[0] || hookInput.cwd || process.cwd();

  // Set log context
  setLogContext(cwd, getSessionName(cwd));

  if (!shouldLogTool(toolName, toolInput)) {
    process.exit(0);
  }

  const summary = formatToolSummary(toolName, toolInput, toolResponse);
  logHook("post-tool-use", summary, { tool: toolName });

  // INSTANT: Update local claude context file (~2ms)
  appendClaudeWork(summary);

  // Upload to Honcho and wait for completion, bounded by UPLOAD_TIMEOUT_MS. The
  // failure was previously written to the log file only — invisible in the
  // terminal even though a dropped write means memory silently didn't happen.
  const outcome = await withUploadTimeout(logToHonchoAsync(config, cwd, summary), UPLOAD_TIMEOUT_MS);
  if (outcome.status === "error") {
    logHook("post-tool-use", `Upload failed: ${outcome.error}`, { error: outcome.error });
  } else if (outcome.status === "skipped") {
    logHook("post-tool-use", `Upload skipped: ${outcome.reason}`, { skipped: outcome.reason });
  }

  // ONE stdout write carrying the capture line, any failure, and (verbose only)
  // the hook duration — Claude Code parses hook stdout as a single JSON
  // document, so this hook must not print twice. At "error"/"off" the capture
  // and duration lines drop and only the failure (if any) survives.
  visCaptureWithError(summary, outcome.status === "error" ? outcome.error : null, {
    uploaded: outcome.status === "uploaded",
    durationMs: Date.now() - hookStart,
  });

  process.exit(0);
}

async function logToHonchoAsync(config: any, cwd: string, summary: string): Promise<UploadOutcome> {
  // Skip if message saving is disabled, or if [Tool] logging isn't opted in.
  if (config.saveMessages === false) {
    return { status: "skipped", reason: "saveMessages is false" };
  }
  if (config.saveToolUse !== true) {
    return { status: "skipped", reason: "saveToolUse not enabled" };
  }

  const honcho = new Honcho(getHonchoClientOptions(config));
  const sessionName = getSessionName(cwd);

  // Session and peer lookups are independent — resolve them concurrently rather
  // than paying two sequential round-trips on every captured tool call.
  const [session, aiPeer] = await Promise.all([
    honcho.session(sessionName),
    honcho.peer(config.aiPeer),
  ]);

  // Log the tool use with instance_id and session_affinity for project-scoped fact extraction
  logApiCall("session.addMessages", "POST", `tool: ${summary.slice(0, 50)}`);
  const instanceId = getClaudeInstanceId();

  await session.addMessages([
    aiPeer.message(`[Tool] ${summary}`, {
      metadata: {
        instance_id: instanceId || undefined,
        session_affinity: sessionName,
      },
    }),
  ]);

  return { status: "uploaded" };
}
