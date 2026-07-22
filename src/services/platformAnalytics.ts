/**
 * Aggregates platform-wide analytics for the admin Global Data page.
 */

type AppRow = {
  id: string;
  student_id: string;
  school_id: string;
  status: string;
  applied_date?: string | null;
  interview_date?: string | null;
  school?: { id: string; name: string } | null;
};

type ExpRow = {
  student_id: string;
  category: string;
  sessions?: { duration?: number | null }[] | null;
};

function monthsBetween(d1: Date, d2: Date): number {
  let months = (d2.getFullYear() - d1.getFullYear()) * 12;
  months -= d1.getMonth();
  months += d2.getMonth();
  return months <= 0 ? 0 : months;
}

function isInterviewedStatus(status: string): boolean {
  return ['Interviewed', 'Accepted', 'Waitlisted', 'Rejected'].includes(status);
}

function isAcceptedStatus(status: string): boolean {
  return status === 'Accepted';
}

function sumHours(exps: ExpRow[], category: string): number {
  return exps
    .filter((e) => e.category === category)
    .reduce((acc, e) => {
      const sessions = e.sessions || [];
      return acc + sessions.reduce((s, sess) => s + (Number(sess.duration) || 0), 0);
    }, 0);
}

export function buildPlatformAnalytics(input: {
  studentUsers: { id: string; name: string; avatar?: string | null; created_at?: string }[];
  profiles: Record<string, any>;
  mentorUsers: { id: string; name: string; avatar?: string | null }[];
  mentorProfiles: Record<string, any>;
  applications: AppRow[];
  experiences: ExpRow[];
}) {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  const elevenMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, now.getDate());
  const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
  const oneAndHalfMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate() - 15);

  const appsByStudent = new Map<string, AppRow[]>();
  for (const app of input.applications) {
    const list = appsByStudent.get(app.student_id) || [];
    list.push(app);
    appsByStudent.set(app.student_id, list);
  }

  const expsByStudent = new Map<string, ExpRow[]>();
  for (const exp of input.experiences) {
    const list = expsByStudent.get(exp.student_id) || [];
    list.push(exp);
    expsByStudent.set(exp.student_id, list);
  }

  const mentorNameById = new Map(input.mentorUsers.map((m) => [m.id, m.name]));
  const studentsAssigned = new Map<string, number>();

  const studentRows = input.studentUsers.map((user) => {
    const profile = input.profiles[user.id] || {};
    const apps = appsByStudent.get(user.id) || [];
    const exps = expsByStudent.get(user.id) || [];
    const createdAt = profile.created_at || user.created_at || now.toISOString();
    const mentorshipMonths = monthsBetween(new Date(createdAt), now);
    const mentorId = profile.mentor_id || null;
    if (mentorId) {
      studentsAssigned.set(mentorId, (studentsAssigned.get(mentorId) || 0) + 1);
    }

    const recentApps = apps.filter((a) => {
      const d = a.applied_date;
      return d && new Date(d) >= elevenMonthsAgo;
    });
    const hasApplied = recentApps.length > 0 || apps.some((a) => a.status === 'Applied' || isInterviewedStatus(a.status));
    const hasAccepted = apps.some((a) => isAcceptedStatus(a.status));
    const hasInterviewed = apps.some(
      (a) => isInterviewedStatus(a.status) || Boolean(a.interview_date),
    );

    return {
      id: user.id,
      name: user.name || 'Student',
      avatar: user.avatar || null,
      gpa: profile.gpa != null ? Number(profile.gpa) : null,
      datAA: profile.dat_aa != null ? Number(profile.dat_aa) : null,
      strengthScore: profile.strength_score != null ? Number(profile.strength_score) : null,
      applicationCycle: profile.application_cycle || null,
      mentorId,
      mentorName: mentorId ? mentorNameById.get(mentorId) || 'Unassigned' : 'Unassigned',
      lastMeetingDate: profile.last_meeting_date || null,
      nextMeetingDate: profile.next_meeting_date || null,
      lastContactDate: profile.last_contact_date || null,
      mentorshipMonths,
      shadowingHours: sumHours(exps, 'Shadowing'),
      volunteerHours: sumHours(exps, 'Volunteering'),
      hasApplied,
      hasAccepted,
      hasInterviewed,
      appliedInWindow: recentApps.length > 0,
      interviewCount: apps.filter((a) => isInterviewedStatus(a.status) || Boolean(a.interview_date)).length,
      createdAt,
    };
  });

  const appliedStudents = studentRows.filter((s) => s.appliedInWindow || s.hasApplied);
  const appliedWindow = studentRows.filter((s) => s.appliedInWindow);
  const appliedPool = appliedWindow.length > 0 ? appliedWindow : appliedStudents;

  const interviewedCount = appliedPool.filter((s) => s.hasInterviewed).length;
  const acceptedCount = appliedPool.filter((s) => s.hasAccepted).length;
  const activeStudents = studentRows.filter(
    (s) => s.lastMeetingDate && new Date(s.lastMeetingDate) >= sixMonthsAgo,
  ).length;

  const totalInterviews = appliedPool.reduce((acc, s) => acc + s.interviewCount, 0);
  const avgInterviewsPerApplied =
    appliedPool.length > 0 ? totalInterviews / appliedPool.length : 0;

  const mentorRows = input.mentorUsers.map((m) => {
    const profile = input.mentorProfiles[m.id] || {};
    const hours = Number(profile.avg_response_time_value) || 0;
    return {
      id: m.id,
      name: m.name || 'Mentor',
      avatar: m.avatar || null,
      studentCount: studentsAssigned.get(m.id) || 0,
      avgResponse: profile.avg_response_time || `${hours}h`,
      avgResponseHours: hours,
    };
  });

  const avgResponseHours =
    mentorRows.length > 0
      ? mentorRows.reduce((a, m) => a + m.avgResponseHours, 0) / mentorRows.length
      : 0;

  // School performance
  const schoolStats: Record<
    string,
    { name: string; applications: number; interviews: number; acceptances: number }
  > = {};
  for (const app of input.applications) {
    const key = app.school_id || app.school?.id || 'unknown';
    const name = app.school?.name || 'Unknown school';
    if (!schoolStats[key]) {
      schoolStats[key] = { name, applications: 0, interviews: 0, acceptances: 0 };
    }
    schoolStats[key].applications++;
    if (isInterviewedStatus(app.status) || app.interview_date) {
      schoolStats[key].interviews++;
    }
    if (isAcceptedStatus(app.status)) {
      schoolStats[key].acceptances++;
    }
  }
  const schoolPerformance = Object.values(schoolStats)
    .sort((a, b) => b.interviews - a.interviews || b.applications - a.applications)
    .slice(0, 8);

  // Application timing
  const months: Record<string, number> = {};
  for (const app of input.applications) {
    const dateStr = app.applied_date;
    if (dateStr && dateStr.length >= 7) {
      const month = dateStr.substring(0, 7);
      months[month] = (months[month] || 0) + 1;
    }
  }
  const applicationTiming = Object.entries(months)
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-18);

  // Funnel by mentorship duration
  const groups: Record<string, { total: number; accepted: number }> = {
    '0-3 Months': { total: 0, accepted: 0 },
    '4-7 Months': { total: 0, accepted: 0 },
    '8-12 Months': { total: 0, accepted: 0 },
    '12+ Months': { total: 0, accepted: 0 },
  };
  for (const s of studentRows) {
    let label = '0-3 Months';
    if (s.mentorshipMonths > 12) label = '12+ Months';
    else if (s.mentorshipMonths >= 8) label = '8-12 Months';
    else if (s.mentorshipMonths >= 4) label = '4-7 Months';
    groups[label].total++;
    if (s.hasAccepted) groups[label].accepted++;
  }
  const funnelByMentorship = Object.entries(groups).map(([name, data]) => ({
    name,
    rate: data.total > 0 ? (data.accepted / data.total) * 100 : 0,
    count: data.total,
  }));

  // Alerts
  const noNextMeeting = studentRows
    .filter((s) => !s.nextMeetingDate && s.mentorId)
    .map((s) => ({ id: s.id, name: s.name, mentorName: s.mentorName }));
  const noContactOneMonth = studentRows
    .filter((s) => s.lastContactDate && new Date(s.lastContactDate) < oneMonthAgo)
    .map((s) => ({
      id: s.id,
      name: s.name,
      mentorName: s.mentorName,
      lastContact: s.lastContactDate,
    }));
  const noMeetingOneAndHalfMonth = studentRows
    .filter((s) => s.lastMeetingDate && new Date(s.lastMeetingDate) < oneAndHalfMonthsAgo)
    .map((s) => ({
      id: s.id,
      name: s.name,
      mentorName: s.mentorName,
      lastMeeting: s.lastMeetingDate,
    }));

  // Signals from real accepted vs not
  const accepted = studentRows.filter((s) => s.hasAccepted);
  const nonAccepted = studentRows.filter((s) => !s.hasAccepted);
  const avg = (vals: number[]) =>
    vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const acceptedDat = avg(accepted.map((s) => s.datAA).filter((v): v is number => v != null));
  const nonAcceptedDat = avg(nonAccepted.map((s) => s.datAA).filter((v): v is number => v != null));
  const acceptedMonths = avg(accepted.map((s) => s.mentorshipMonths));
  const acceptedShadow = avg(accepted.map((s) => s.shadowingHours));
  const shadowPct =
    accepted.length > 0
      ? (accepted.filter((s) => s.shadowingHours >= 100).length / accepted.length) * 100
      : 0;

  const signals = [
    {
      title: 'DAT Threshold Advantage',
      desc: `Accepted students averaged ${acceptedDat.toFixed(1)} DAT vs ${nonAcceptedDat.toFixed(1)} for others.`,
      strength: acceptedDat > nonAcceptedDat + 2 ? 'Strong' : acceptedDat > nonAcceptedDat ? 'Moderate' : 'Emerging',
    },
    {
      title: 'Mentorship Duration',
      desc: `Accepted students worked with the platform for ${acceptedMonths.toFixed(1)} months on average.`,
      strength: acceptedMonths > 6 ? 'Strong' : acceptedMonths > 3 ? 'Moderate' : 'Emerging',
    },
    {
      title: 'Shadowing Consistency',
      desc: `${shadowPct.toFixed(0)}% of accepted students logged 100+ shadowing hours (avg ${acceptedShadow.toFixed(0)}h).`,
      strength: shadowPct >= 60 ? 'Strong' : shadowPct >= 35 ? 'Moderate' : 'Emerging',
    },
  ];

  // Top acceptance trends (real combinations)
  const trendDefs: {
    label: string;
    tags: string[];
    match: (s: (typeof studentRows)[0]) => boolean;
  }[] = [
    {
      label: 'GPA 3.5+ & DAT 22+ & 6mo Mentorship',
      tags: ['Academic', 'Mentorship'],
      match: (s) => (s.gpa || 0) >= 3.5 && (s.datAA || 0) >= 22 && s.mentorshipMonths >= 6,
    },
    {
      label: 'Shadowing 120h & Volunteer 150h',
      tags: ['Extracurricular'],
      match: (s) => s.shadowingHours >= 120 && s.volunteerHours >= 150,
    },
    {
      label: 'DAT 20+ & 6mo Mentorship',
      tags: ['Testing', 'Mentorship'],
      match: (s) => (s.datAA || 0) >= 20 && s.mentorshipMonths >= 6,
    },
    {
      label: 'GPA 3.7+ & Shadowing 100h+',
      tags: ['Academic', 'Extracurricular'],
      match: (s) => (s.gpa || 0) >= 3.7 && s.shadowingHours >= 100,
    },
  ];

  const topTrends = trendDefs
    .map((t) => {
      const matched = studentRows.filter(t.match);
      const sample = matched.length;
      const acceptedN = matched.filter((s) => s.hasAccepted).length;
      return {
        label: t.label,
        tags: t.tags,
        sample,
        rate: sample > 0 ? Math.round((acceptedN / sample) * 100) : 0,
      };
    })
    .filter((t) => t.sample > 0)
    .sort((a, b) => b.rate - a.rate || b.sample - a.sample)
    .slice(0, 4);

  // Recommendation from funnel
  const early = groups['0-3 Months'];
  const late = groups['8-12 Months'];
  const earlyRate = early.total > 0 ? early.accepted / early.total : 0;
  const lateRate = late.total > 0 ? late.accepted / late.total : 0;
  const lift =
    earlyRate > 0 ? Math.round(((lateRate - earlyRate) / Math.max(earlyRate, 0.01)) * 100) : 0;
  const recommendation =
    late.total > 0
      ? `Students with 8–12 months of mentorship show a ${Math.max(lift, 0)}% higher acceptance rate than those with under 3 months (${(lateRate * 100).toFixed(0)}% vs ${(earlyRate * 100).toFixed(0)}%).`
      : 'Collect more application outcomes to unlock mentorship timing recommendations.';

  const cycles = Array.from(
    new Set(
      studentRows
        .map((s) => s.applicationCycle)
        .filter((c): c is string => Boolean(c)),
    ),
  ).sort();

  const appliedCount = appliedPool.length;

  return {
    summary: {
      totalStudents: studentRows.length,
      activeStudents,
      appliedCount,
      interviewedCount,
      acceptedCount,
      avgInterviewsPerApplied: Number(avgInterviewsPerApplied.toFixed(2)),
      avgResponseHours: Number(avgResponseHours.toFixed(1)),
    },
    interviewPie: [
      { name: 'Interviewed', value: interviewedCount },
      { name: 'Not Interviewed', value: Math.max(appliedCount - interviewedCount, 0) },
    ],
    acceptancePie: [
      { name: 'Accepted', value: acceptedCount },
      { name: 'Not Accepted', value: Math.max(appliedCount - acceptedCount, 0) },
    ],
    applicationTiming,
    funnelByMentorship,
    schoolPerformance,
    mentors: mentorRows.sort((a, b) => a.avgResponseHours - b.avgResponseHours),
    alerts: {
      noNextMeeting,
      noContactOneMonth,
      noMeetingOneAndHalfMonth,
    },
    signals,
    topTrends,
    recommendation,
    cycles,
    students: studentRows,
  };
}

export type PlatformAnalytics = ReturnType<typeof buildPlatformAnalytics>;
