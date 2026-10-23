/**
 * Copy the Summary and Next steps out of a Gemini "Full notes" doc.
 * Who owns a next step comes from the transcript when that is clear.
 * When it is not clear, the step is left unassigned instead of guessed.
 */

export interface ExtractedNextMeeting {
  date: string;
  time: string;
}

export interface ExtractedActionItem {
  task: string;
  /** YYYY-MM-DD when the transcript named a deadline. Empty when it did not. */
  dueDate: string;
}

export interface ExtractedGeminiNotes {
  summary: string;
  studentActionItems: ExtractedActionItem[];
  mentorActionItems: ExtractedActionItem[];
  unassignedActionItems: ExtractedActionItem[];
  hasSummary: boolean;
  hasNextSteps: boolean;
  nextMeeting: ExtractedNextMeeting | null;
}

export interface ExtractNotesOptions {
  mentorName?: string;
  meetingDate?: string;
}

type SectionName = "summary" | "decisions" | "next" | "details" | "transcript";
type Owner = "student" | "mentor" | "unassigned";

const BOILERPLATE = /you should review gemini|how is the quality of these specific notes|get tips and learn how gemini takes notes|take a short survey/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function headingOf(line: string): SectionName | null {
  const cleaned = line.replace(/^[^a-zA-Z]+/, "").replace(/[:：]\s*$/, "").trim();
  if (/^summary$/i.test(cleaned)) return "summary";
  if (/^decisions?$/i.test(cleaned)) return "decisions";
  if (/^(next steps|suggested next steps|action items)$/i.test(cleaned)) return "next";
  if (/^details$/i.test(cleaned)) return "details";
  if (/^transcript$/i.test(cleaned)) return "transcript";
  return null;
}

function personName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function isStudentOwner(owner: string, studentName: string): boolean {
  return namesMatch(owner, studentName);
}

function namesMatch(owner: string, person: string): boolean {
  const ownerName = personName(owner);
  const other = personName(person);
  if (!ownerName || !other) return false;
  if (ownerName === other) return true;
  const ownerFirst = ownerName.split(" ")[0];
  const otherFirst = other.split(" ")[0];
  if (ownerFirst.length >= 3 && ownerFirst === otherFirst) return true;
  return other.includes(ownerName) || ownerName.includes(other);
}

/** Gemini doc title, date stamp, and "Meeting records" lines are not tasks. */
function isDocChrome(line: string): boolean {
  const cleaned = line.replace(/^[^a-zA-Z0-9]+/, "").trim();
  if (!cleaned || BOILERPLATE.test(cleaned)) return true;
  if (/^(full notes|meeting records?|transcript|meeting|notes|gemini notes)$/i.test(cleaned)) return true;
  if (/^(?:meeting\s+)?[A-Z][a-z]+\s+\d{1,2},\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}(?:\s*[AP]M)?(?:\s*[A-Z]{2,5})?)?$/i.test(cleaned)) {
    return true;
  }
  return false;
}

function cleanTask(text: string): string {
  const cut = text.split(/📝|\bFull notes\b|\bMeeting records\b/i)[0] || "";
  const cleaned = cut.replace(/\s+/g, " ").trim();
  if (!cleaned || isDocChrome(cleaned)) return "";
  return cleaned;
}

function looksLikeName(line: string): boolean {
  const cleaned = line.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?$/, "").trim();
  if (isDocChrome(cleaned)) return false;
  return /^[A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){0,3}$/.test(cleaned);
}

function parseTurns(transcript: string): Array<{ speaker: string; text: string }> {
  const turns: Array<{ speaker: string; text: string }> = [];
  let speaker = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    if (speaker && text) turns.push({ speaker, text });
    buf = [];
  };
  for (const raw of transcript.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || isDocChrome(line)) continue;
    const inline = line.match(/^([A-Za-z][A-Za-z.' -]{1,60}?)(?::|\s{2,})\s+(\S.*)$/);
    if (inline && looksLikeName(inline[1].trim())) {
      flush();
      speaker = inline[1].replace(/\s+\d{1,2}:\d{2}(?::\d{2})?$/, "").trim();
      buf.push(inline[2]);
      continue;
    }
    if (looksLikeName(line) && line.split(/\s+/).length >= 2) {
      flush();
      speaker = line.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?$/, "").trim();
      continue;
    }
    if (speaker) buf.push(line);
  }
  flush();
  return turns;
}

function inferMentorName(
  turns: Array<{ speaker: string; text: string }>,
  studentName: string,
  explicit: string,
): string {
  if (explicit.trim()) return explicit.trim();
  const counts = new Map<string, number>();
  for (const turn of turns) {
    if (namesMatch(turn.speaker, studentName)) continue;
    counts.set(turn.speaker, (counts.get(turn.speaker) || 0) + turn.text.split(/\s+/).length);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "";
  if (ranked.length === 1) return ranked[0][0];
  if (ranked[0][1] >= ranked[1][1] * 1.5) return ranked[0][0];
  return "";
}

function roleOf(speaker: string, studentName: string, mentorName: string): Owner | "unknown" {
  if (namesMatch(speaker, studentName)) return "student";
  if (mentorName && namesMatch(speaker, mentorName)) return "mentor";
  return "unknown";
}

const STOP = new Set([
  "that", "this", "with", "from", "your", "will", "should", "need", "have", "about",
  "into", "they", "them", "next", "step", "just", "going", "want", "make", "sure",
]);

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !STOP.has(word));
}

function relevantTurns(task: string, turns: Array<{ speaker: string; text: string }>) {
  const words = keywords(task);
  if (!words.length) return [];
  const needed = words.length === 1 ? 1 : 2;
  return turns.filter((turn) => {
    const hay = turn.text.toLowerCase();
    return words.filter((word) => hay.includes(word)).length >= Math.min(needed, words.length);
  });
}

function selfCommit(text: string): boolean {
  return /\b(i(?:'ll| will)|i(?:'m| am) going to|i can|i'll)\b/i.test(text);
}

function assignsToStudent(text: string, studentName: string): boolean {
  const first = personName(studentName).split(" ")[0];
  if (/\b(the )?student (will|should|needs to|has to|is going to)\b/i.test(text)) return true;
  if (/\bhave (the )?student\b/i.test(text)) return true;
  if (/\bask (the )?student to\b/i.test(text)) return true;
  if (/\byou (should|need to|have to|will|'ll)\b/i.test(text)) return true;
  if (first.length >= 3 && new RegExp(`\\b${first}\\b.{0,48}\\b(will|should|needs to|has to|is going to)\\b`, "i").test(text)) {
    return true;
  }
  return false;
}

function assignTask(
  task: string,
  bracket: string,
  turns: Array<{ speaker: string; text: string }>,
  studentName: string,
  mentorName: string,
): Owner {
  const nearby = relevantTurns(task, turns);
  const studentCommit = nearby.some((turn) => roleOf(turn.speaker, studentName, mentorName) === "student" && selfCommit(turn.text));
  const mentorCommit = nearby.some((turn) => roleOf(turn.speaker, studentName, mentorName) === "mentor" && selfCommit(turn.text));
  const mentorGivesStudent = nearby.some(
    (turn) => roleOf(turn.speaker, studentName, mentorName) === "mentor" && assignsToStudent(turn.text, studentName),
  );

  if (studentCommit && !mentorCommit) return "student";
  if (mentorGivesStudent && !mentorCommit) return "student";
  if (mentorCommit && !studentCommit && !mentorGivesStudent) return "mentor";

  if (assignsToStudent(task, studentName) && !selfCommit(task)) return "student";
  if (selfCommit(task) && namesMatch(bracket, studentName)) return "student";
  if (selfCommit(task) && mentorName && namesMatch(bracket, mentorName)) return "mentor";

  if (namesMatch(bracket, studentName)) return "student";
  if (mentorName && namesMatch(bracket, mentorName) && selfCommit(task)) return "mentor";
  return "unassigned";
}

function addDays(meetingDate: string, days: number): string {
  const base = new Date(`${meetingDate.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return "";
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** A deadline named in the task or the lines where it was discussed. Never guessed. */
function findDueDate(text: string, meetingDate: string): string {
  const source = text.replace(/\s+/g, " ");
  const named = source.match(
    /\b(?:by|due|before|until|on)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i,
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    let year = named[3] ? Number(named[3]) : Number(meetingDate.slice(0, 4)) || new Date().getUTCFullYear();
    let iso = isoDate(year, month, day);
    if (iso && meetingDate && iso < meetingDate.slice(0, 10)) iso = isoDate(year + 1, month, day);
    if (iso) return iso;
  }
  const weekday = source.match(/\b(?:by|due|before|until)\s+(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekday && meetingDate) return nextWeekday(meetingDate, weekday[1]);
  const relative = source.match(/\b(?:in|within)\s+(\d+)\s+(day|week)s?\b/i);
  if (relative && meetingDate) {
    const count = Number(relative[1]);
    const days = relative[2].toLowerCase().startsWith("week") ? count * 7 : count;
    if (count > 0 && count < 60) return addDays(meetingDate, days);
  }
  if (meetingDate && /\bend of (?:this |the )?week\b/i.test(source)) return nextWeekday(meetingDate, "friday");
  return "";
}

function parseNextSteps(
  block: string,
  transcript: string,
  studentName: string,
  mentorName: string,
  meetingDate: string,
): { student: ExtractedActionItem[]; mentor: ExtractedActionItem[]; unassigned: ExtractedActionItem[] } {
  const turns = parseTurns(transcript);
  const resolvedMentor = inferMentorName(turns, studentName, mentorName);
  const student: ExtractedActionItem[] = [];
  const mentor: ExtractedActionItem[] = [];
  const unassigned: ExtractedActionItem[] = [];
  let current: { owner: string; text: string } | null = null;

  const flush = () => {
    if (!current) return;
    const text = cleanTask(current.text);
    if (text) {
      const nearby = relevantTurns(text, turns).map((turn) => turn.text).join(" ");
      const item = { task: text, dueDate: findDueDate(`${text} ${nearby}`, meetingDate) };
      const owner = assignTask(text, current.owner, turns, studentName, resolvedMentor);
      if (owner === "student") student.push(item);
      else if (owner === "mentor") mentor.push(item);
      else unassigned.push(item);
    }
    current = null;
  };

  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || isDocChrome(line) || BOILERPLATE.test(line)) {
      if (isDocChrome(line)) flush();
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
    else current = { owner: "", text: line };
  }
  flush();
  return { student, mentor, unassigned };
}

function isoDate(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return date.toISOString().slice(0, 10);
}

function nextWeekday(meetingDate: string, weekdayName: string): string {
  const target = WEEKDAYS.indexOf(weekdayName.toLowerCase());
  const base = new Date(`${meetingDate.slice(0, 10)}T12:00:00Z`);
  if (target < 0 || Number.isNaN(base.getTime())) return "";
  let delta = (target - base.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

function extractNextMeeting(parts: string[], meetingDate: string): ExtractedNextMeeting | null {
  const sentences = parts.join("\n").split(/(?<=[.!?])\s+|\n+/);
  const scheduling = sentences.filter((sentence) =>
    /next meeting|meet again|follow[- ]?up meeting|(?:let'?s|let us)\s+meet|\bmeet\s+(?:again|next|on)\b|same time|see you (?:next|on)|book (?:a |the )?meeting|schedule (?:for|our|the|a|another) (?:next )?meeting/i.test(sentence),
  );
  if (!scheduling.length) return null;
  const blob = scheduling.join(" ");
  let time = "";
  const clock = blob.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] || "00";
    const afternoon = clock[3].toLowerCase().startsWith("p");
    if (hour <= 12) {
      if (afternoon && hour < 12) hour += 12;
      if (!afternoon && hour === 12) hour = 0;
      time = `${String(hour).padStart(2, "0")}:${minute}`;
    }
  }

  let date = "";
  const named = blob.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    let year = named[3] ? Number(named[3]) : Number(meetingDate.slice(0, 4)) || new Date().getUTCFullYear();
    const iso = isoDate(year, month, day);
    if (iso && meetingDate && iso < meetingDate.slice(0, 10)) {
      date = isoDate(year + 1, month, day);
    } else {
      date = iso;
    }
  } else {
    const weekday = blob.match(/\b(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (weekday && meetingDate) date = nextWeekday(meetingDate, weekday[1]);
  }

  if (!date && !time) return null;
  return { date, time };
}

export function extractGeminiFullNotes(
  text: string,
  studentName = "",
  options: ExtractNotesOptions = {},
): ExtractedGeminiNotes {
  const empty: ExtractedGeminiNotes = {
    summary: "",
    studentActionItems: [],
    mentorActionItems: [],
    unassignedActionItems: [],
    hasSummary: false,
    hasNextSteps: false,
    nextMeeting: null,
  };
  const source = String(text || "").replace(/\u000b/g, "\n");
  if (!source.trim()) return empty;

  let section: SectionName | null = null;
  const buckets: Record<SectionName, string[]> = {
    summary: [],
    decisions: [],
    next: [],
    details: [],
    transcript: [],
  };

  for (const raw of source.split(/\r?\n/)) {
    const heading = headingOf(raw);
    if (heading) {
      section = heading;
      continue;
    }
    if (!section || BOILERPLATE.test(raw)) continue;
    buckets[section].push(raw.trimEnd());
  }

  const summary = buckets.summary.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const steps = parseNextSteps(
    buckets.next.join("\n"),
    buckets.transcript.join("\n"),
    studentName,
    options.mentorName || "",
    options.meetingDate || "",
  );
  const meetingDate = options.meetingDate || "";

  return {
    summary,
    studentActionItems: steps.student,
    mentorActionItems: steps.mentor,
    unassignedActionItems: steps.unassigned,
    hasSummary: summary.length > 0,
    hasNextSteps: buckets.next.some((line) => line.trim()),
    nextMeeting: extractNextMeeting(
      [summary, buckets.next.join("\n"), buckets.transcript.join("\n")],
      meetingDate,
    ),
  };
}
