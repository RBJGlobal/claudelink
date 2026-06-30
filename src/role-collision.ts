// Pure formatters for the role-collision UX guards.
//
// Two unrelated terminals can register under the same generic role string (e.g.
// "developer"): the agents table intentionally allows duplicate roles and
// `sendMessage` fans out to every match. That fan-out is correct by design, but
// it is INVISIBLE — a directed send to a shared role silently delivers to every
// terminal holding it, and each gets nudged "check for updates" for mail meant
// for one. (Seen in practice: several terminals each registered as a bare
// "developer", and one send addressed to that role fanned out to all of them.)
//
// These two notices surface the collision at the two moments it matters:
// registration (#2) and send (#3). Kept pure + exported so the wording is
// unit-tested independently of the MCP server boot path.

export interface AgentLabel {
  role: string;
  description: string | null;
}

// Identify an agent for a human reader. Siblings of a collision all share the
// same role, so the description is what actually disambiguates them; fall back
// to the role alone when there is no description.
function label(a: AgentLabel): string {
  const d = a.description ? a.description.trim() : "";
  const short = d.length > 70 ? d.slice(0, 67) + "..." : d;
  return short ? `${a.role} — ${short}` : a.role;
}

// #2 — shown in the register response when the just-registered role is already
// held by >= 1 other LIVE agent. `siblings` are the other live agents sharing
// the role (caller excludes self and dead rows). Returns null when there is no
// collision, so the caller can append unconditionally.
export function roleCollisionWarning(
  role: string,
  siblings: AgentLabel[]
): string | null {
  if (siblings.length === 0) return null;
  const lines = siblings.map((s) => `      • ${label(s)}`).join("\n");
  return (
    `⚠️  Role "${role}" is already held by ${siblings.length} other live agent(s):\n` +
    `${lines}\n` +
    `    Messages sent to role "${role}" fan out to ALL of them — each gets nudged\n` +
    `    to "check for updates" for mail meant for one. To avoid cross-talk, register\n` +
    `    with a unique, project-qualified role (e.g. "<project> ${role}").`
  );
}

// #3 — appended to the send response when a directed send matched > 1 agent, so
// the sender SEES the fan-out instead of it being silent. Returns null for the
// normal single-recipient case.
export function fanoutNotice(
  role: string,
  recipients: AgentLabel[]
): string | null {
  if (recipients.length <= 1) return null;
  const lines = recipients.map((r) => `      • ${label(r)}`).join("\n");
  return (
    `⚠️  Role "${role}" matched ${recipients.length} agents — this message fanned out to all:\n` +
    `${lines}\n` +
    `    If you meant just one, target a unique role (get_agents lists them).`
  );
}
