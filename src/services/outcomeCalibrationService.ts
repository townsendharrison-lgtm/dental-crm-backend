import { supabaseAdmin } from '../config/supabase.js';

export interface HistoricalApplicationInput {
  studentNameAnonymized: string;
  schoolId?: string;
  schoolName: string;
  cycle?: string;
  cgpa: number;
  sgpa?: number;
  datAa: number;
  datTs: number;
  datPat?: number;
  shadowingHours?: number;
  volunteeringHours?: number;
  dentalExperienceHours?: number;
  researchHours?: number;
  isInState?: boolean;
  state?: string;
  applicantType?: 'FIRST_TIME' | 'REAPPLICANT';
  outcome: 'ACCEPTED' | 'INTERVIEWED' | 'WAITLISTED' | 'REJECTED';
  source?: 'CRM_SYNC' | 'CSV_UPLOAD' | 'MANUAL_ENTRY' | 'RESEARCH_CASE';
  notes?: string;
}

/**
 * Synchronizes active student profiles & application outcomes from the CRM into the historical dataset.
 */
export async function syncCrmStudentsToHistorical(): Promise<{ syncedCount: number; errors: string[] }> {
  const errors: string[] = [];
  let syncedCount = 0;

  try {
    // 1. Fetch student profiles joined with applications & user info
    const { data: students, error: studentErr } = await supabaseAdmin
      .from('student_profiles')
      .select('id, strength_score, gpa, sgpa, dat_score, dat_aa, dat_ts, dat_pat, state, applicant_type, is_reapplicant');

    if (studentErr) throw studentErr;
    if (!students || students.length === 0) return { syncedCount: 0, errors: [] };

    // 2. Fetch experience hours per student
    const { data: experiences } = await supabaseAdmin
      .from('experiences')
      .select('student_id, category, total_hours');

    const expMap: Record<string, { shadowing: number; volunteering: number; dental: number; research: number }> = {};
    (experiences || []).forEach((exp) => {
      if (!expMap[exp.student_id]) {
        expMap[exp.student_id] = { shadowing: 0, volunteering: 0, dental: 0, research: 0 };
      }
      const cat = (exp.category || '').toLowerCase();
      const hrs = Number(exp.total_hours || 0);
      if (cat.includes('shadow')) expMap[exp.student_id].shadowing += hrs;
      else if (cat.includes('volunteer') || cat.includes('community')) expMap[exp.student_id].volunteering += hrs;
      else if (cat.includes('dental') || cat.includes('assistant') || cat.includes('hygien')) expMap[exp.student_id].dental += hrs;
      else if (cat.includes('research')) expMap[exp.student_id].research += hrs;
    });

    // 3. Fetch applications with outcomes
    const { data: apps, error: appErr } = await supabaseAdmin
      .from('student_schools')
      .select('student_id, school_id, status, notes, school:schools(id, name, location)');

    if (appErr) throw appErr;

    const rowsToInsert: any[] = [];

    (apps || []).forEach((app) => {
      const student = students.find((s) => s.id === app.student_id);
      if (!student) return;

      const rawStatus = (app.status || '').toUpperCase();
      let outcome: 'ACCEPTED' | 'INTERVIEWED' | 'WAITLISTED' | 'REJECTED' | null = null;
      if (rawStatus === 'ACCEPTED') outcome = 'ACCEPTED';
      else if (rawStatus === 'INTERVIEWED') outcome = 'INTERVIEWED';
      else if (rawStatus === 'WAITLISTED') outcome = 'WAITLISTED';
      else if (rawStatus === 'REJECTED') outcome = 'REJECTED';
      else return; // Skip in-progress statuses like Interested/Applying

      const school = (app as any).school;
      const schoolId = app.school_id;
      const schoolName = school?.name || 'Dental School';
      const schoolLocation = school?.location || '';

      const isInState = Boolean(
        student.state && schoolLocation.toLowerCase().includes(student.state.toLowerCase())
      );

      const exp = expMap[student.id] || { shadowing: 0, volunteering: 0, dental: 0, research: 0 };

      rowsToInsert.push({
        student_name_anonymized: `CRM Applicant #${student.id.substring(0, 6)}`,
        school_id: schoolId,
        school_name: schoolName,
        cycle: '2025-2026',
        cgpa: Number(student.gpa || student.sgpa || 3.5),
        sgpa: student.sgpa ? Number(student.sgpa) : null,
        dat_aa: Number(student.dat_aa || student.dat_score || 20),
        dat_ts: Number(student.dat_ts || student.dat_aa || student.dat_score || 20),
        dat_pat: student.dat_pat ? Number(student.dat_pat) : null,
        shadowing_hours: exp.shadowing,
        volunteering_hours: exp.volunteering,
        dental_experience_hours: exp.dental,
        research_hours: exp.research,
        is_in_state: isInState,
        state: student.state || null,
        applicant_type: student.is_reapplicant ? 'REAPPLICANT' : 'FIRST_TIME',
        outcome,
        source: 'CRM_SYNC',
        notes: app.notes || null,
      });
    });

    if (rowsToInsert.length > 0) {
      const { error: insertErr } = await supabaseAdmin
        .from('historical_applications')
        .insert(rowsToInsert);

      if (insertErr) {
        errors.push(insertErr.message);
      } else {
        syncedCount = rowsToInsert.length;
      }
    }
  } catch (err: any) {
    errors.push(err.message || String(err));
  }

  return { syncedCount, errors };
}

/**
 * Batch uploads historical applicant records (from CSV/JSON files).
 */
export async function batchUploadHistorical(
  items: HistoricalApplicationInput[]
): Promise<{ insertedCount: number; errors: string[] }> {
  const errors: string[] = [];
  let insertedCount = 0;

  if (!items || items.length === 0) {
    return { insertedCount: 0, errors: ['No records provided for upload.'] };
  }

  try {
    // Look up schools map to assign valid school_id
    const { data: schools } = await supabaseAdmin.from('schools').select('id, name');
    const schoolMap = new Map<string, string>();
    (schools || []).forEach((s) => {
      schoolMap.set(s.name.toLowerCase().trim(), s.id);
      schoolMap.set(s.id, s.id);
    });

    const rows = items.map((item, idx) => {
      let resolvedSchoolId = item.schoolId;
      if (!resolvedSchoolId && item.schoolName) {
        resolvedSchoolId = schoolMap.get(item.schoolName.toLowerCase().trim());
      }
      if (!resolvedSchoolId) {
        resolvedSchoolId = 'sch1'; // Default fallback
      }

      return {
        student_name_anonymized:
          item.studentNameAnonymized || `Applicant #${idx + 1}`,
        school_id: resolvedSchoolId,
        school_name: item.schoolName,
        cycle: item.cycle || '2025-2026',
        cgpa: Number(item.cgpa) || 3.5,
        sgpa: item.sgpa ? Number(item.sgpa) : null,
        dat_aa: Number(item.datAa) || 20,
        dat_ts: Number(item.datTs) || 20,
        dat_pat: item.datPat ? Number(item.datPat) : null,
        shadowing_hours: Number(item.shadowingHours || 0),
        volunteering_hours: Number(item.volunteeringHours || 0),
        dental_experience_hours: Number(item.dentalExperienceHours || 0),
        research_hours: Number(item.researchHours || 0),
        is_in_state: Boolean(item.isInState),
        state: item.state || null,
        applicant_type: item.applicantType || 'FIRST_TIME',
        outcome: item.outcome,
        source: item.source || 'CSV_UPLOAD',
        notes: item.notes || null,
      };
    });

    const { error } = await supabaseAdmin
      .from('historical_applications')
      .insert(rows);

    if (error) {
      errors.push(error.message);
    } else {
      insertedCount = rows.length;
    }
  } catch (err: any) {
    errors.push(err.message || String(err));
  }

  return { insertedCount, errors };
}

/**
 * Calibrates school-specific scoring rubrics and weights based on historical applicant outcomes.
 */
export async function calibrateSchoolRubrics(schoolId?: string): Promise<{
  calibratedSchoolsCount: number;
  calibratedRubrics: any[];
}> {
  let query = supabaseAdmin.from('historical_applications').select('*');
  if (schoolId) {
    query = query.eq('school_id', schoolId);
  }

  const { data: historicalRows } = await query;
  if (!historicalRows || historicalRows.length === 0) {
    return { calibratedSchoolsCount: 0, calibratedRubrics: [] };
  }

  // Group by school_id
  const bySchool: Record<string, any[]> = {};
  historicalRows.forEach((row) => {
    if (!bySchool[row.school_id]) bySchool[row.school_id] = [];
    bySchool[row.school_id].push(row);
  });

  const calibratedRubrics: any[] = [];

  for (const [targetSchoolId, rows] of Object.entries(bySchool)) {
    const acceptedOrInterviewed = rows.filter((r) =>
      r.outcome === 'ACCEPTED' || r.outcome === 'INTERVIEWED'
    );
    const rejected = rows.filter((r) => r.outcome === 'REJECTED');

    const sample = acceptedOrInterviewed.length > 0 ? acceptedOrInterviewed : rows;

    const avgCgpa =
      sample.reduce((sum, r) => sum + Number(r.cgpa || 0), 0) / sample.length;
    const avgDatAa =
      sample.reduce((sum, r) => sum + Number(r.dat_aa || 0), 0) / sample.length;
    const avgShadowing =
      sample.reduce((sum, r) => sum + Number(r.shadowing_hours || 0), 0) /
      sample.length;
    const avgVolunteering =
      sample.reduce((sum, r) => sum + Number(r.volunteering_hours || 0), 0) /
      sample.length;
    const avgResearch =
      sample.reduce((sum, r) => sum + Number(r.research_hours || 0), 0) /
      sample.length;

    // Minimum 5th percentile bounds
    const sortedGpa = [...sample].map((r) => Number(r.cgpa)).sort((a, b) => a - b);
    const sortedDat = [...sample].map((r) => Number(r.dat_aa)).sort((a, b) => a - b);
    const p5Gpa = sortedGpa[Math.floor(sortedGpa.length * 0.05)] || 3.1;
    const p5Dat = sortedDat[Math.floor(sortedDat.length * 0.05)] || 18;

    // Empirical weights estimation
    let gpaW = 25;
    let datW = 30;
    let shadW = 15;
    let volW = 10;
    let resW = 5;
    let inStateW = 10;
    let lorW = 5;

    if (avgShadowing > 120) shadW += 5;
    if (avgVolunteering > 100) volW += 5;
    if (avgResearch > 60) resW += 5;
    if (avgDatAa >= 22) datW += 5;

    // Normalize weights to 100
    const totalW = gpaW + datW + shadW + volW + resW + inStateW + lorW;
    const normalizedWeights = {
      gpaWeight: Math.round((gpaW / totalW) * 100),
      datWeight: Math.round((datW / totalW) * 100),
      shadowingWeight: Math.round((shadW / totalW) * 100),
      volunteeringWeight: Math.round((volW / totalW) * 100),
      researchWeight: Math.round((resW / totalW) * 100),
      inStateWeight: Math.round((inStateW / totalW) * 100),
      lorWeight: Math.round((lorW / totalW) * 100),
    };

    const cutoffs = {
      minCgpa: Number(p5Gpa.toFixed(2)),
      avgCgpa: Number(avgCgpa.toFixed(2)),
      minDatAa: Math.round(p5Dat),
      avgDatAa: Number(avgDatAa.toFixed(1)),
      minShadowing: Math.max(40, Math.round(avgShadowing * 0.4)),
      recommendedShadowing: Math.round(avgShadowing),
      minVolunteering: Math.max(30, Math.round(avgVolunteering * 0.4)),
      recommendedVolunteering: Math.round(avgVolunteering),
      minLor: 3,
    };

    const { data: updatedRubric } = await supabaseAdmin
      .from('school_scoring_rubrics')
      .upsert({
        school_id: targetSchoolId,
        weights: normalizedWeights,
        cutoffs,
        calibrated_from_outcomes_count: rows.length,
        last_calibrated_at: new Date().toISOString(),
        calibration_notes: `Empirically calibrated from ${rows.length} past application outcomes (${acceptedOrInterviewed.length} accepted/interviewed, ${rejected.length} rejected).`,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'school_id' })
      .select()
      .single();

    if (updatedRubric) {
      calibratedRubrics.push(updatedRubric);
    }
  }

  return {
    calibratedSchoolsCount: calibratedRubrics.length,
    calibratedRubrics,
  };
}
