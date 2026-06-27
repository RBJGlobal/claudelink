// Stage 1 — the operator's standard "your context is high" prompt, formatted
// with measured numbers per agent. Single source of truth for the CLI
// subcommand (claudelink prompt-clear) and the Command Center fleet view's
// "copy prompt" button.
//
// Pure function: no fs, no fetch, no globals. The caller supplies the
// measurements; this just shapes the text. That keeps the formatter trivially
// testable and makes both surfaces (CLI / UI) emit byte-identical prompts.

export interface PromptClearArgs {
  role: string;
  model: string;
  contextTokens: number;
  windowTokens: number;
  perTurnUsd: number;
}

export function buildPromptClearText(args: PromptClearArgs): string {
  const ctxK = Math.round(args.contextTokens / 1000);
  const pct = ((args.contextTokens / args.windowTokens) * 100).toFixed(0);
  const usd = args.perTurnUsd.toFixed(2);
  const model = args.model.replace(/^claude-/, "");
  return [
    `# Agent: ${args.role} (${model}) — context ~${ctxK}K / ${pct}% of window — per-turn re-read ≈ $${usd}`,
    `# Paste the block below into the ${args.role} terminal:`,
    ``,
    `You've been working a while. Your context is ~${ctxK}K tokens (${pct}% of this model's window), with per-turn cache-read cost ≈ $${usd}. It's wise to either compact or clear.`,
    ``,
    `Please assess: are you at a safe stopping point?`,
    ``,
    `If YES:`,
    `  1. Update HANDOVER.md with: current task, decisions worth keeping, the exact next step, open threads.`,
    `  2. Update MEMORY.md (or your project's memory file) if anything should persist across sessions.`,
    `  3. Reply "ready" and tell me whether you'd prefer /compact (keeps a summary) or /clear (wipes context, relies on HANDOVER + MEMORY).`,
    ``,
    `If you have work in flight, just say so — we can continue and revisit later.`,
  ].join("\n");
}
