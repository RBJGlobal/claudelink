// Resolves the settings a register call ends up with. An option the caller
// omits falls back to the role's previous registration, then to the default.
// Pure, so the rule is unit-tested without an MCP server.

export interface PreviousRoleSettings {
  description: string | null;
  autonomousReply: boolean;
}

export function resolveRegisterSettings(
  args: { description?: unknown; autonomousReply?: unknown },
  previous: PreviousRoleSettings | null
): { description: string | null; autonomousReply: boolean; restored: string[] } {
  const restored: string[] = [];

  let description: string | null;
  if (typeof args.description === "string") {
    // An explicit empty string clears the description.
    description = args.description.length > 0 ? args.description : null;
  } else if (previous?.description) {
    description = previous.description;
    restored.push("description");
  } else {
    description = null;
  }

  let autonomousReply: boolean;
  if (args.autonomousReply !== undefined) {
    autonomousReply = Boolean(args.autonomousReply);
  } else if (previous) {
    autonomousReply = previous.autonomousReply;
    // Only worth saying when it differs from the default a caller would assume.
    if (!autonomousReply) restored.push("autonomousReply=false");
  } else {
    autonomousReply = true;
  }

  return { description, autonomousReply, restored };
}
