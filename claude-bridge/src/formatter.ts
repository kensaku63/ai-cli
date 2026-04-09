/**
 * Response formatter — Truncates large outputs to save Claude Code's context window.
 *
 * Strategy:
 *   < 2KB  → return as-is
 *   2-10KB → head + tail with truncation notice
 *   > 10KB → structured summary + truncation notice
 */

const SMALL_THRESHOLD = 2 * 1024;
const LARGE_THRESHOLD = 10 * 1024;
const HEAD_SIZE = 1024;
const TAIL_SIZE = 512;

export function formatOutput(output: string): string {
  if (output.length <= SMALL_THRESHOLD) {
    return output;
  }

  const lines = output.split("\n");

  if (output.length <= LARGE_THRESHOLD) {
    const head = output.slice(0, HEAD_SIZE);
    const tail = output.slice(-TAIL_SIZE);
    const truncatedLines = lines.length;
    return [
      head,
      `\n... (truncated: ${truncatedLines} lines, ${output.length} bytes total) ...\n`,
      tail,
    ].join("");
  }

  // Large output: structured summary
  return [
    output.slice(0, HEAD_SIZE),
    `\n\n--- OUTPUT TRUNCATED ---`,
    `Total: ${lines.length} lines, ${output.length} bytes`,
    `Showing first ${HEAD_SIZE} bytes and last ${TAIL_SIZE} bytes.`,
    `---\n`,
    output.slice(-TAIL_SIZE),
  ].join("\n");
}

export function formatError(message: string, details?: string): string {
  if (details) {
    return `Error: ${message}\n\nDetails:\n${formatOutput(details)}`;
  }
  return `Error: ${message}`;
}
