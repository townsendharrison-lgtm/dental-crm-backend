/**
 * Copy the Summary and Next steps out of a Gemini "Full notes" doc.
 * The wording stays as written in the document.
 */

export interface ExtractedGeminiNotes {
  summary: string;
  studentActionItems: string[];
  mentorActionItems: string[];
  /** True when a Summary heading was found. */
  hasSummary: boolean;
  /** True when a Next steps heading was found. */
  hasNextSteps: boolean;
}

type SectionName = "summary" | "decisions" | "next" | "details" | "transcript";

const BOILERPLATE = /you should review gemini|how is the quality of these specific notes|get tips and learn how gemini takes notes|take a short survey/i;

function headingOf(line: string): SectionName | null {
  const cleaned = line
    .replace(/^[^a-zA-Z]+/, "")
    .replace(/[:：]\s*$/, "")
    .trim();
  if (/^summary$/i.test(cleaned)) return "summary";
  if (/^decisions?$/i.test(cleaned)) return "decisions";
  if (/^(next steps|suggested next steps|action items)$/i.test(cleaned)) return "next";
  if (/^details$/i.test(cleaned)) return "details";
  if (/^transcript$/i.test(cleaned)) return "transcript";
  return null;
}

function personName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bracket name belongs to the student when it shares their first or full name. */
export function isStudentOwner(owner: string, studentName: string): boolean {
  const ownerName = personName(owner);
  const student = personName(studentName);
  if (!ownerName || !student) return false;
  if (ownerName === student) return true;
  const ownerFirst = ownerName.split(" ")[0];
  const studentFirst = student.split(" ")[0];
  if (ownerFirst.length >= 3 && ownerFirst === studentFirst) return true;
  return student.includes(ownerName) || ownerName.includes(student);
}

function parseNextSteps(block: string, studentName: string): { student: string[]; mentor: string[] } {
  const student: string[] = [];
  const mentor: string[] = [];
  const lines = block.split(/\r?\n/);
  let current: { owner: string; text: string } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.text.replace(/\s+/g, " ").trim();
    if (text) {
      if (isStudentOwner(current.owner, studentName)) student.push(text);
      else mentor.push(text);
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || BOILERPLATE.test(line)) {
      if (BOILERPLATE.test(line)) flush();
      continue;
    }
    if (/^aligned$/i.test(line)) continue;
    const match = line.match(/^(?:[-*•]\s*)?\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      flush();
      current = { owner: match[1].trim(), text: match[2].trim() };
      continue;
    }
    if (current) current.text = `${current.text} ${line}`.trim();
  }
  flush();
  return { student, mentor };
}

export function extractGeminiFullNotes(
  text: string,
  studentName = "",
): ExtractedGeminiNotes {
  const empty: ExtractedGeminiNotes = {
    summary: "",
    studentActionItems: [],
    mentorActionItems: [],
    hasSummary: false,
    hasNextSteps: false,
  };
  const source = String(text || "").replace(/\u000b/g, "\n");
  if (!source.trim()) return empty;

  const lines = source.split(/\r?\n/);
  let section: SectionName | null = null;
  const buckets: Record<SectionName, string[]> = {
    summary: [],
    decisions: [],
    next: [],
    details: [],
    transcript: [],
  };

  for (const raw of lines) {
    const heading = headingOf(raw);
    if (heading) {
      section = heading;
      continue;
    }
    if (!section || BOILERPLATE.test(raw)) continue;
    buckets[section].push(raw.trimEnd());
  }

  const summary = buckets.summary
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const steps = parseNextSteps(buckets.next.join("\n"), studentName);

  return {
    summary,
    studentActionItems: steps.student,
    mentorActionItems: steps.mentor,
    hasSummary: summary.length > 0,
    hasNextSteps: buckets.next.some((line) => line.trim()),
  };
}
