export interface StudentProfileForPrediction {
  id?: string;
  name?: string;
  cgpa?: number | null;
  sgpa?: number | null;
  datAa?: number | null;
  datTs?: number | null;
  datPat?: number | null;
  shadowingHours?: number | null;
  volunteeringHours?: number | null;
  dentalExperienceHours?: number | null;
  researchHours?: number | null;
  lorCount?: number | null;
  state?: string | null;
  isReapplicant?: boolean | null;
  tookCcClasses?: boolean | null;
  isCanadianDat?: boolean | null;
  completedCourses?: string[] | null;
}

export interface RequirementCheckItem {
  id: string;
  name: string;
  status: 'MET' | 'WARNING' | 'UNMET';
  studentValue: string | number;
  schoolRequirement: string | number;
  details: string;
  isHardRequirement: boolean;
  citationId?: string;
}

export interface RoiImprovement {
  id: string;
  actionTitle: string;
  description: string;
  category: 'DAT' | 'GPA' | 'SHADOWING' | 'VOLUNTEERING' | 'RESEARCH' | 'PREREQUISITES' | 'LOR';
  currentMetric: string | number;
  targetMetric: string | number;
  probabilityLift: {
    interviewLift: number; // e.g. +14%
    acceptanceLift: number; // e.g. +18%
  };
  impactLevel: 'HIGH' | 'MEDIUM' | 'MODERATE';
}

export interface PredictionResult {
  schoolId: string;
  schoolName: string;
  location: string;
  fitCategory: 'Strong Fit' | 'Target' | 'Reach' | 'Safety' | 'High Risk';
  matchScore: number; // 0 to 100
  requirementsStatus: 'MEETS_ALL' | 'WARNINGS' | 'FAILS_REQUIREMENTS';
  requirementsPassedCount: number;
  requirementsTotalCount: number;
  requirements: RequirementCheckItem[];
  probabilities: {
    interviewProbability: number; // % (0-100)
    acceptedProbability: number; // % (0-100)
    waitlistProbability: number; // % (0-100)
    rejectionProbability: number; // % (0-100)
  };
  diagnostics: {
    mostLikelyReason: string;
    mostLimitingFactor: string;
    highestRoiImprovements: RoiImprovement[];
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Evaluates a student against a dental school's criteria and scoring rubrics.
 */
export function evaluateStudentForSchool(
  student: StudentProfileForPrediction,
  school: any,
  rubric?: any
): PredictionResult {
  const schoolName = school.name || 'Dental School';
  const schoolLocation = school.location || 'United States';

  // Rubric weights (defaults if not present)
  const weights = rubric?.weights || {
    gpaWeight: 25,
    datWeight: 30,
    shadowingWeight: 15,
    volunteeringWeight: 10,
    researchWeight: 5,
    inStateWeight: 10,
    lorWeight: 5,
  };

  const cutoffs = rubric?.cutoffs || {
    minCgpa: school.min_cgpa_5th || 3.0,
    minSgpa: 3.0,
    avgCgpa: school.avg_gpa || 3.65,
    avgSgpa: 3.60,
    minDatAa: school.min_dat_5th || 18,
    avgDatAa: school.dat_avg || 20.8,
    minDatTs: 18,
    avgDatTs: 20.5,
    minDatPat: 17,
    minShadowing: 50,
    recommendedShadowing: 100,
    minVolunteering: 50,
    recommendedVolunteering: 100,
    minLor: 3,
  };

  const holistic = rubric?.holistic_factors || {
    inStatePreferenceMultiplier: 1.3,
    canadianDatAccepted: true,
    communityCollegeAccepted: school.cc_credits !== false,
    casperRequired: false,
    interviewFormat: 'Traditional',
  };

  // Student metrics
  const cgpa = Number(student.cgpa || 0);
  const sgpa = Number(student.sgpa || cgpa || 0);
  const datAa = Number(student.datAa || 0);
  const datTs = Number(student.datTs || datAa || 0);
  const datPat = Number(student.datPat || 18);
  const shadowing = Number(student.shadowingHours || 0);
  const volunteering = Number(student.volunteeringHours || 0);
  const dentalExp = Number(student.dentalExperienceHours || 0);
  const research = Number(student.researchHours || 0);
  const lorCount = Number(student.lorCount || 3);

  // Check state match
  const isSchoolInState =
    student.state &&
    schoolLocation.toLowerCase().includes(student.state.trim().toLowerCase());

  // 1. Requirements & Prerequisite Checklist
  const requirements: RequirementCheckItem[] = [];

  // Cumulative GPA Check
  if (cgpa > 0) {
    if (cgpa < cutoffs.minCgpa) {
      requirements.push({
        id: 'req_cgpa',
        name: 'Cumulative GPA Minimum',
        status: 'UNMET',
        studentValue: cgpa.toFixed(2),
        schoolRequirement: `≥ ${cutoffs.minCgpa.toFixed(2)}`,
        details: `Your cGPA (${cgpa.toFixed(2)}) is below the school's minimum threshold (${cutoffs.minCgpa.toFixed(2)}).`,
        isHardRequirement: true,
      });
    } else if (cgpa < cutoffs.avgCgpa - 0.25) {
      requirements.push({
        id: 'req_cgpa',
        name: 'Cumulative GPA Competitiveness',
        status: 'WARNING',
        studentValue: cgpa.toFixed(2),
        schoolRequirement: `Avg ~${cutoffs.avgCgpa.toFixed(2)}`,
        details: `Your cGPA (${cgpa.toFixed(2)}) meets the minimum but is below the entering class average (${cutoffs.avgCgpa.toFixed(2)}).`,
        isHardRequirement: false,
      });
    } else {
      requirements.push({
        id: 'req_cgpa',
        name: 'Cumulative GPA',
        status: 'MET',
        studentValue: cgpa.toFixed(2),
        schoolRequirement: `≥ ${cutoffs.minCgpa.toFixed(2)} (Avg ${cutoffs.avgCgpa.toFixed(2)})`,
        details: `Strong GPA alignment with matriculant profile.`,
        isHardRequirement: true,
      });
    }
  }

  // DAT Academic Average Check
  if (datAa > 0) {
    if (datAa < cutoffs.minDatAa) {
      requirements.push({
        id: 'req_dat_aa',
        name: 'DAT Academic Average (AA)',
        status: 'UNMET',
        studentValue: datAa,
        schoolRequirement: `≥ ${cutoffs.minDatAa}`,
        details: `DAT AA (${datAa}) is below the school's cutoff of ${cutoffs.minDatAa}.`,
        isHardRequirement: true,
      });
    } else if (datAa < cutoffs.avgDatAa - 1.5) {
      requirements.push({
        id: 'req_dat_aa',
        name: 'DAT Academic Average (AA)',
        status: 'WARNING',
        studentValue: datAa,
        schoolRequirement: `Avg ~${cutoffs.avgDatAa}`,
        details: `DAT AA (${datAa}) meets baseline cutoff but is under the class average of ${cutoffs.avgDatAa}.`,
        isHardRequirement: false,
      });
    } else {
      requirements.push({
        id: 'req_dat_aa',
        name: 'DAT Academic Average (AA)',
        status: 'MET',
        studentValue: datAa,
        schoolRequirement: `Avg ~${cutoffs.avgDatAa}`,
        details: `Competitive DAT score exceeding target threshold.`,
        isHardRequirement: true,
      });
    }
  }

  // Shadowing Hours Check
  if (shadowing < (cutoffs.minShadowing || 50)) {
    requirements.push({
      id: 'req_shadowing',
      name: 'Dental Shadowing Hours',
      status: 'UNMET',
      studentValue: `${shadowing} hrs`,
      schoolRequirement: `≥ ${cutoffs.minShadowing || 50} hrs`,
      details: `Logged shadowing (${shadowing} hrs) is below the required ${cutoffs.minShadowing || 50} hours.`,
      isHardRequirement: true,
    });
  } else if (shadowing < (cutoffs.recommendedShadowing || 100)) {
    requirements.push({
      id: 'req_shadowing',
      name: 'Dental Shadowing Hours',
      status: 'WARNING',
      studentValue: `${shadowing} hrs`,
      schoolRequirement: `Rec. ${cutoffs.recommendedShadowing || 100} hrs`,
      details: `Meets minimum (${cutoffs.minShadowing || 50} hrs) but below recommended ${cutoffs.recommendedShadowing || 100} hours.`,
      isHardRequirement: false,
    });
  } else {
    requirements.push({
      id: 'req_shadowing',
      name: 'Dental Shadowing Hours',
      status: 'MET',
      studentValue: `${shadowing} hrs`,
      schoolRequirement: `≥ ${cutoffs.recommendedShadowing || 100} hrs`,
      details: `Excellent shadowing depth exceeding recommended benchmarks.`,
      isHardRequirement: true,
    });
  }

  // Volunteering Hours Check
  if (volunteering < (cutoffs.minVolunteering || 40)) {
    requirements.push({
      id: 'req_volunteering',
      name: 'Community Service & Volunteering',
      status: 'WARNING',
      studentValue: `${volunteering} hrs`,
      schoolRequirement: `Rec. ${cutoffs.recommendedVolunteering || 80} hrs`,
      details: `Volunteering experience (${volunteering} hrs) is on the lower side for holistic screening.`,
      isHardRequirement: false,
    });
  } else {
    requirements.push({
      id: 'req_volunteering',
      name: 'Community Service & Volunteering',
      status: 'MET',
      studentValue: `${volunteering} hrs`,
      schoolRequirement: `≥ ${cutoffs.minVolunteering || 40} hrs`,
      details: `Solid community involvement logged.`,
      isHardRequirement: false,
    });
  }

  // Letters of Recommendation Check
  if (lorCount < (cutoffs.minLor || 3)) {
    requirements.push({
      id: 'req_lor',
      name: 'Letters of Recommendation',
      status: 'UNMET',
      studentValue: `${lorCount} letters`,
      schoolRequirement: `≥ ${cutoffs.minLor || 3} letters`,
      details: `School requires at least ${cutoffs.minLor || 3} recommendation letters.`,
      isHardRequirement: true,
    });
  } else {
    requirements.push({
      id: 'req_lor',
      name: 'Letters of Recommendation',
      status: 'MET',
      studentValue: `${lorCount} letters`,
      schoolRequirement: `≥ ${cutoffs.minLor || 3} letters`,
      details: `Sufficient letters collected.`,
      isHardRequirement: true,
    });
  }

  // Community College policy
  if (student.tookCcClasses && holistic.communityCollegeAccepted === false) {
    requirements.push({
      id: 'req_cc',
      name: 'Community College Credits Policy',
      status: 'UNMET',
      studentValue: 'CC Classes Taken',
      schoolRequirement: '4-Year Institution Only',
      details: 'This school restricts or does not accept prerequisite coursework from community colleges.',
      isHardRequirement: true,
    });
  }

  // Canadian DAT policy
  if (student.isCanadianDat && holistic.canadianDatAccepted === false) {
    requirements.push({
      id: 'req_canadian_dat',
      name: 'Canadian DAT Acceptance',
      status: 'UNMET',
      studentValue: 'Canadian DAT',
      schoolRequirement: 'US DAT Required',
      details: 'This school requires the US American Dental Association (ADA) DAT examination.',
      isHardRequirement: true,
    });
  }

  // Overall requirements status
  const unmetCount = requirements.filter((r) => r.status === 'UNMET').length;
  const warningCount = requirements.filter((r) => r.status === 'WARNING').length;
  const passedCount = requirements.filter((r) => r.status === 'MET').length;

  const requirementsStatus =
    unmetCount > 0
      ? 'FAILS_REQUIREMENTS'
      : warningCount > 0
      ? 'WARNINGS'
      : 'MEETS_ALL';

  // 2. Compute Metric Standings (Z-scores / percentile scaling)
  // Scaled 0 to 1 for each bucket
  const gpaScore = cgpa ? clamp((cgpa - 2.8) / (4.0 - 2.8), 0, 1) : 0.5;
  const datScore = datAa ? clamp((datAa - 16) / (26 - 16), 0, 1) : 0.5;
  const shadowingScore = clamp(shadowing / 120, 0, 1);
  const volunteeringScore = clamp(volunteering / 100, 0, 1);
  const researchScore = clamp(research / 80, 0, 1);
  const inStateScore = isSchoolInState ? 1.0 : 0.5;
  const lorScore = clamp(lorCount / 4, 0, 1);

  const totalWeight =
    weights.gpaWeight +
    weights.datWeight +
    weights.shadowingWeight +
    weights.volunteeringWeight +
    weights.researchWeight +
    weights.inStateWeight +
    weights.lorWeight;

  const weightedSum =
    (gpaScore * weights.gpaWeight +
      datScore * weights.datWeight +
      shadowingScore * weights.shadowingWeight +
      volunteeringScore * weights.volunteeringWeight +
      researchScore * weights.researchWeight +
      inStateScore * weights.inStateWeight +
      lorScore * weights.lorWeight) /
    (totalWeight || 100);

  // Match score (0–100)
  let rawMatch = Math.round(weightedSum * 100);
  if (requirementsStatus === 'FAILS_REQUIREMENTS') {
    rawMatch = Math.min(rawMatch, 48); // Cap match if failing hard requirement
  }
  const matchScore = clamp(rawMatch, 5, 98);

  // 3. Compute 4-Outcome Probabilities
  // Base acceptance rate of school (e.g. 5%)
  const rawAccRate = Number(
    isSchoolInState
      ? school.is_acceptance_rate ?? school.acceptance_rate ?? 6.5
      : school.oos_acceptance_rate ?? school.acceptance_rate ?? 4.5
  );
  const baselineAccRate = isNaN(rawAccRate) || rawAccRate <= 0 ? 5.0 : rawAccRate;

  // Log-odds distance factor from matriculant average
  const gpaDiff = (cgpa || 3.4) - (cutoffs.avgCgpa || 3.65);
  const datDiff = (datAa || 19) - (cutoffs.avgDatAa || 20.8);
  const expFactor =
    (Math.min(shadowing, 150) / 100 + Math.min(volunteering, 150) / 100) / 2;

  let interviewLogit =
    -0.8 +
    gpaDiff * 2.8 +
    datDiff * 0.38 +
    (expFactor - 1.0) * 0.8 +
    (isSchoolInState ? 0.65 : -0.1);

  if (unmetCount > 0) {
    interviewLogit -= 2.2;
  }

  // Interview Probability (ranges realistically from 5% to 85%)
  const rawInterviewProb = Math.round(sigmoid(interviewLogit) * 100);
  const interviewProbability = clamp(
    unmetCount > 0 ? Math.min(rawInterviewProb, 12) : rawInterviewProb,
    3,
    88
  );

  // Acceptance given interview probability (usually 35% - 75% for interviewed candidates)
  const postInterviewLogit =
    0.2 + gpaDiff * 1.5 + datDiff * 0.25 + (isSchoolInState ? 0.35 : 0);
  const postInterviewAccRate = sigmoid(postInterviewLogit);

  // Overall Accepted Probability
  const acceptedProbability = clamp(
    Math.round((interviewProbability / 100) * postInterviewAccRate * 100),
    unmetCount > 0 ? 1 : 2,
    76
  );

  // Waitlist Probability (typically 10% - 25% of interviewed or high-scoring near-misses)
  const waitlistProbability = clamp(
    Math.round((interviewProbability / 100) * (1 - postInterviewAccRate) * 0.45 * 100),
    2,
    28
  );

  // Rejection Probability = remaining
  const rejectionProbability = clamp(
    100 - acceptedProbability - waitlistProbability,
    5,
    97
  );

  // 4. Fit Categorization
  let fitCategory: PredictionResult['fitCategory'] = 'Target';
  if (unmetCount > 0 || matchScore < 45 || acceptedProbability < 8) {
    fitCategory = 'High Risk';
  } else if (matchScore >= 82 && acceptedProbability >= 45) {
    fitCategory = isSchoolInState ? 'Safety' : 'Strong Fit';
  } else if (matchScore >= 68 && acceptedProbability >= 25) {
    fitCategory = 'Target';
  } else {
    fitCategory = 'Reach';
  }

  // 5. Explainable AI Diagnostics
  // Most Likely Reason
  let mostLikelyReason = '';
  if (datAa >= (cutoffs.avgDatAa || 20.8) + 1.0) {
    mostLikelyReason = `Your DAT AA (${datAa}) is well above the school average of ${cutoffs.avgDatAa}, positioning your academic profile among the top tier of applicants.`;
  } else if (cgpa >= (cutoffs.avgCgpa || 3.65) + 0.15) {
    mostLikelyReason = `Your strong cumulative GPA (${cgpa.toFixed(2)}) significantly exceeds the matriculant median (${cutoffs.avgCgpa.toFixed(2)}).`;
  } else if (isSchoolInState) {
    mostLikelyReason = `In-state residency provides a significant admissions multiplier and higher interview conversion odds at ${schoolName}.`;
  } else if (shadowing >= 120 && volunteering >= 100) {
    mostLikelyReason = `Extensive clinical shadowing (${shadowing}h) and community service (${volunteering}h) provide excellent holistic differentiation.`;
  } else {
    mostLikelyReason = `Balanced profile meeting baseline criteria; interview outcome will hinge on personal statement and secondary application alignment.`;
  }

  // Most Limiting Factor
  let mostLimitingFactor = '';
  if (unmetCount > 0) {
    const unmet = requirements.find((r) => r.status === 'UNMET');
    mostLimitingFactor = `Critical barrier: ${unmet?.name} (${unmet?.studentValue} vs required ${unmet?.schoolRequirement}).`;
  } else if (shadowing < (cutoffs.recommendedShadowing || 100)) {
    mostLimitingFactor = `Clinical exposure: Logged ${shadowing} shadowing hours vs recommended ${cutoffs.recommendedShadowing || 100} hours.`;
  } else if (datAa < (cutoffs.avgDatAa || 20.8)) {
    mostLimitingFactor = `DAT Score: Academic Average of ${datAa} is below the school's entering average of ${cutoffs.avgDatAa}.`;
  } else if (!isSchoolInState && (school.oos_acceptance_rate || 0) < 4.0) {
    mostLimitingFactor = `Out-of-state residency: This institution accepts a limited percentage of non-resident candidates.`;
  } else if (volunteering < 60) {
    mostLimitingFactor = `Community service hours (${volunteering}h) are below the competitive threshold for holistic review.`;
  } else {
    mostLimitingFactor = `High overall applicant pool volume creates intense competition despite strong metrics.`;
  }

  // Highest ROI Improvements
  const highestRoiImprovements: RoiImprovement[] = [];

  // Shadowing ROI
  if (shadowing < 100) {
    const targetShadow = Math.min(100, Math.max(shadowing + 40, 80));
    highestRoiImprovements.push({
      id: 'roi_shadowing',
      actionTitle: `Log +${targetShadow - shadowing} General Dental Shadowing Hours`,
      description: `Complete structured shadowing across general and specialty practices to reach ${targetShadow} hours.`,
      category: 'SHADOWING',
      currentMetric: `${shadowing} hrs`,
      targetMetric: `${targetShadow} hrs`,
      probabilityLift: {
        interviewLift: clamp(Math.round((targetShadow - shadowing) * 0.35), 6, 18),
        acceptanceLift: clamp(Math.round((targetShadow - shadowing) * 0.25), 4, 14),
      },
      impactLevel: 'HIGH',
    });
  }

  // DAT Retake ROI
  if (datAa > 0 && datAa < (cutoffs.avgDatAa || 21)) {
    const targetDat = Math.min(datAa + 2, 23);
    highestRoiImprovements.push({
      id: 'roi_dat',
      actionTitle: `Target +${targetDat - datAa} on DAT Retake (Aim for ${targetDat} AA)`,
      description: `Increasing DAT Academic Average to ${targetDat} crosses into the 75th percentile of applicants.`,
      category: 'DAT',
      currentMetric: `${datAa} AA`,
      targetMetric: `${targetDat} AA`,
      probabilityLift: {
        interviewLift: clamp((targetDat - datAa) * 11, 10, 26),
        acceptanceLift: clamp((targetDat - datAa) * 9, 8, 22),
      },
      impactLevel: 'HIGH',
    });
  }

  // Volunteering ROI
  if (volunteering < 80) {
    highestRoiImprovements.push({
      id: 'roi_volunteering',
      actionTitle: `Add 30+ Underserved Community Service Hours`,
      description: `Demonstrate commitment to public health and patient care through consistent volunteer service.`,
      category: 'VOLUNTEERING',
      currentMetric: `${volunteering} hrs`,
      targetMetric: `${volunteering + 30} hrs`,
      probabilityLift: {
        interviewLift: 8,
        acceptanceLift: 6,
      },
      impactLevel: 'MEDIUM',
    });
  }

  // GPA Booster (Post-bac / Master's course)
  if (cgpa > 0 && cgpa < 3.4) {
    highestRoiImprovements.push({
      id: 'roi_gpa',
      actionTitle: `Complete Upper-Division Science Post-Bac Courses`,
      description: `Show strong upward grade trajectory in upper-level Biology and Biochemistry to offset lower undergrad GPA.`,
      category: 'GPA',
      currentMetric: `${cgpa.toFixed(2)} GPA`,
      targetMetric: `3.55+ in recent coursework`,
      probabilityLift: {
        interviewLift: 14,
        acceptanceLift: 11,
      },
      impactLevel: 'HIGH',
    });
  }

  return {
    schoolId: school.id,
    schoolName,
    location: schoolLocation,
    fitCategory,
    matchScore,
    requirementsStatus,
    requirementsPassedCount: passedCount,
    requirementsTotalCount: requirements.length,
    requirements,
    probabilities: {
      interviewProbability,
      acceptedProbability,
      waitlistProbability,
      rejectionProbability,
    },
    diagnostics: {
      mostLikelyReason,
      mostLimitingFactor,
      highestRoiImprovements,
    },
  };
}
