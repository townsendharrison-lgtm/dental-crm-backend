import { GoogleGenAI, Type } from '@google/genai';
import { supabaseAdmin } from '../config/supabase.js';

let aiClient: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI | null {
  if (aiClient) return aiClient;
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
    process.env.API_KEY;
  if (!apiKey) {
    console.warn('Gemini API key is not configured in backend environment.');
    return null;
  }
  aiClient = new GoogleGenAI({ apiKey });
  return aiClient;
}

export type IngestionSourceType = 'URL' | 'PDF' | 'TXT' | 'IMAGE' | 'MANUAL';

export interface ExtractedEvidenceItem {
  category:
    | 'Prerequisites'
    | 'DAT Requirements'
    | 'GPA Requirements'
    | 'Shadowing & Volunteering'
    | 'Residency & Quotas'
    | 'Letters of Recommendation'
    | 'Rubrics & Weights'
    | 'Mission & Culture'
    | 'Interview Format'
    | 'General Information';
  fieldKey: string;
  fieldLabel: string;
  extractedValue: any;
  rawSnippet: string;
  pageNumber?: number | null;
  confidenceScore?: number;
}

export interface IngestionResult {
  schoolId: string;
  schoolName: string;
  sourceType: IngestionSourceType;
  sourceName: string;
  sourceUrl?: string;
  extractedRubric: {
    weights: {
      gpaWeight: number;
      datWeight: number;
      shadowingWeight: number;
      volunteeringWeight: number;
      researchWeight: number;
      inStateWeight: number;
      lorWeight: number;
    };
    cutoffs: {
      minCgpa?: number;
      minSgpa?: number;
      avgCgpa?: number;
      avgSgpa?: number;
      minDatAa?: number;
      avgDatAa?: number;
      minDatTs?: number;
      avgDatTs?: number;
      minDatPat?: number;
      minShadowing?: number;
      recommendedShadowing?: number;
      minVolunteering?: number;
      recommendedVolunteering?: number;
      minLor?: number;
    };
    prerequisites: Array<{
      course: string;
      credits?: number;
      required: boolean;
      labRequired?: boolean;
      minGrade?: string;
    }>;
    holisticFactors: {
      inStatePreferenceMultiplier?: number;
      canadianDatAccepted?: boolean;
      communityCollegeAccepted?: boolean;
      casperRequired?: boolean;
      interviewFormat?: string;
      missionKeywords?: string[];
      notes?: string;
    };
  };
  evidenceList: ExtractedEvidenceItem[];
}

/**
 * Strips HTML tags and script/style tags to extract clean text.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch and extract text from a web URL.
 */
export async function fetchUrlContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 DentalSchoolCRM/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch URL ${url}: ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    return sanitizeHtml(html);
  } catch (err: any) {
    throw new Error(`URL fetch error: ${err.message || String(err)}`);
  }
}

/**
 * Uses Gemini (Multimodal text or Vision) to extract structured criteria and source citations.
 */
export async function extractSchoolCriteriaWithGemini(
  content: { text?: string; imageBase64?: string; mimeType?: string },
  context: { schoolName?: string; sourceName: string; sourceType: IngestionSourceType; sourceUrl?: string }
): Promise<{
  schoolName: string;
  extractedRubric: IngestionResult['extractedRubric'];
  evidenceList: ExtractedEvidenceItem[];
}> {
  const genAI = getGenAI();
  if (!genAI) {
    throw new Error('Gemini API key is not configured. Please set GEMINI_API_KEY.');
  }

  const prompt = `
You are an expert Dental School Admissions Intelligence Agent.
Your task is to analyze dental school admissions materials (web pages, ADEA guides, PDFs, images, fact sheets, or interview transcripts) and extract:
1. Exact School Name (or identify if specified in context: "${context.schoolName || 'Unknown'}").
2. Scoring Weights (how much the school weights GPA, DAT, Shadowing, Volunteering, Research, In-State status, LORs - total must sum to 100).
3. Cutoffs & Percentile Averages (min/avg cGPA, sGPA, DAT AA, TS, PAT, minimum and recommended shadowing and volunteering hours, min LORs).
4. Prerequisite Courses (Biochemistry, General Chemistry, Organic Chemistry, Biology, Physics, Anatomy, Physiology, Math/Stats, English, Microbiology, etc.) and if lab is required.
5. Holistic Factors (In-state preference, Casper requirement, Canadian DAT acceptance, CC credit policy, interview format like MMI/Traditional, mission keywords).
6. EVIDENCE CITATIONS: For EVERY single fact, cutoff, or requirement extracted, provide:
   - category (e.g. 'Prerequisites', 'DAT Requirements', 'GPA Requirements', 'Shadowing & Volunteering', 'Residency & Quotas', 'Letters of Recommendation', 'Rubrics & Weights', 'Mission & Culture', 'Interview Format', 'General Information')
   - fieldKey (e.g. 'min_shadowing_hours', 'avg_dat_aa', 'biochem_required', 'canadian_dat')
   - fieldLabel (Human readable label, e.g., "Minimum Shadowing Hours")
   - extractedValue (the raw value like 100, 21.5, true)
   - rawSnippet (THE EXACT verbatim text sentence or snippet from the document proving this claim, so admissions advisors can verify it).

Source Info:
- Source Name: ${context.sourceName}
- Source Type: ${context.sourceType}
${context.sourceUrl ? `- Source URL: ${context.sourceUrl}` : ''}

${content.text ? `Document Content:\n${content.text.substring(0, 45000)}` : 'Analyze the provided image/document thoroughly.'}
`;

  const contents: any[] = [];
  if (content.imageBase64 && content.mimeType) {
    contents.push({
      inlineData: {
        data: content.imageBase64,
        mimeType: content.mimeType,
      },
    });
  }
  contents.push(prompt);

  const response = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          schoolName: { type: Type.STRING },
          extractedRubric: {
            type: Type.OBJECT,
            properties: {
              weights: {
                type: Type.OBJECT,
                properties: {
                  gpaWeight: { type: Type.NUMBER },
                  datWeight: { type: Type.NUMBER },
                  shadowingWeight: { type: Type.NUMBER },
                  volunteeringWeight: { type: Type.NUMBER },
                  researchWeight: { type: Type.NUMBER },
                  inStateWeight: { type: Type.NUMBER },
                  lorWeight: { type: Type.NUMBER },
                },
                required: [
                  'gpaWeight',
                  'datWeight',
                  'shadowingWeight',
                  'volunteeringWeight',
                  'researchWeight',
                  'inStateWeight',
                  'lorWeight',
                ],
              },
              cutoffs: {
                type: Type.OBJECT,
                properties: {
                  minCgpa: { type: Type.NUMBER },
                  minSgpa: { type: Type.NUMBER },
                  avgCgpa: { type: Type.NUMBER },
                  avgSgpa: { type: Type.NUMBER },
                  minDatAa: { type: Type.NUMBER },
                  avgDatAa: { type: Type.NUMBER },
                  minDatTs: { type: Type.NUMBER },
                  avgDatTs: { type: Type.NUMBER },
                  minDatPat: { type: Type.NUMBER },
                  minShadowing: { type: Type.NUMBER },
                  recommendedShadowing: { type: Type.NUMBER },
                  minVolunteering: { type: Type.NUMBER },
                  recommendedVolunteering: { type: Type.NUMBER },
                  minLor: { type: Type.NUMBER },
                },
              },
              prerequisites: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    course: { type: Type.STRING },
                    credits: { type: Type.NUMBER },
                    required: { type: Type.BOOLEAN },
                    labRequired: { type: Type.BOOLEAN },
                    minGrade: { type: Type.STRING },
                  },
                  required: ['course', 'required'],
                },
              },
              holisticFactors: {
                type: Type.OBJECT,
                properties: {
                  inStatePreferenceMultiplier: { type: Type.NUMBER },
                  canadianDatAccepted: { type: Type.BOOLEAN },
                  communityCollegeAccepted: { type: Type.BOOLEAN },
                  casperRequired: { type: Type.BOOLEAN },
                  interviewFormat: { type: Type.STRING },
                  missionKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
                  notes: { type: Type.STRING },
                },
              },
            },
            required: ['weights', 'cutoffs', 'prerequisites', 'holisticFactors'],
          },
          evidenceList: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                category: {
                  type: Type.STRING,
                  enum: [
                    'Prerequisites',
                    'DAT Requirements',
                    'GPA Requirements',
                    'Shadowing & Volunteering',
                    'Residency & Quotas',
                    'Letters of Recommendation',
                    'Rubrics & Weights',
                    'Mission & Culture',
                    'Interview Format',
                    'General Information',
                  ],
                },
                fieldKey: { type: Type.STRING },
                fieldLabel: { type: Type.STRING },
                extractedValue: { type: Type.STRING },
                rawSnippet: { type: Type.STRING },
                pageNumber: { type: Type.NUMBER },
                confidenceScore: { type: Type.NUMBER },
              },
              required: ['category', 'fieldKey', 'fieldLabel', 'extractedValue', 'rawSnippet'],
            },
          },
        },
        required: ['schoolName', 'extractedRubric', 'evidenceList'],
      },
    },
  });

  const parsed = JSON.parse(response.text || '{}');
  return parsed;
}

/**
 * Persists extracted evidence and updates the school's rubric and profile in Supabase.
 */
export async function saveIngestionResults(
  schoolTargetId: string | null,
  extracted: {
    schoolName: string;
    extractedRubric: IngestionResult['extractedRubric'];
    evidenceList: ExtractedEvidenceItem[];
  },
  meta: {
    sourceType: IngestionSourceType;
    sourceName: string;
    sourceUrl?: string;
    userId?: string;
  }
): Promise<IngestionResult> {
  let targetSchoolId = schoolTargetId;

  // If schoolId is not provided, look up or create school by extracted name
  if (!targetSchoolId) {
    const trimmedName = (extracted.schoolName || 'Unknown Dental School').trim();
    const { data: existing } = await supabaseAdmin
      .from('schools')
      .select('id, name')
      .ilike('name', trimmedName)
      .limit(1)
      .maybeSingle();

    if (existing) {
      targetSchoolId = existing.id;
    } else {
      const { data: created, error: createErr } = await supabaseAdmin
        .from('schools')
        .insert({
          name: trimmedName,
          location: 'United States',
          avg_gpa: extracted.extractedRubric.cutoffs.avgCgpa || 3.6,
          dat_avg: extracted.extractedRubric.cutoffs.avgDatAa || 20.5,
          min_cgpa_5th: extracted.extractedRubric.cutoffs.minCgpa || 3.0,
          min_dat_5th: extracted.extractedRubric.cutoffs.minDatAa || 18,
          cc_credits: extracted.extractedRubric.holisticFactors.communityCollegeAccepted !== false,
          notes: extracted.extractedRubric.holisticFactors.notes || null,
        })
        .select('id, name')
        .single();

      if (createErr) {
        throw new Error(`Failed to ensure school record: ${createErr.message}`);
      }
      targetSchoolId = created.id;
    }
  }

  // 1. Upsert School Scoring Rubric
  const { error: rubricErr } = await supabaseAdmin
    .from('school_scoring_rubrics')
    .upsert({
      school_id: targetSchoolId,
      weights: extracted.extractedRubric.weights,
      cutoffs: extracted.extractedRubric.cutoffs,
      prerequisites: extracted.extractedRubric.prerequisites,
      holistic_factors: extracted.extractedRubric.holisticFactors,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'school_id' });

  if (rubricErr) {
    console.error('Error saving school scoring rubric:', rubricErr);
  }

  // 2. Insert Evidence items into `school_evidence`
  if (extracted.evidenceList && extracted.evidenceList.length > 0) {
    const evidenceRows = extracted.evidenceList.map((ev) => ({
      school_id: targetSchoolId,
      category: ev.category,
      field_key: ev.fieldKey,
      field_label: ev.fieldLabel,
      extracted_value:
        typeof ev.extractedValue === 'string'
          ? { value: ev.extractedValue }
          : ev.extractedValue,
      source_type: meta.sourceType,
      source_name: meta.sourceName,
      source_url: meta.sourceUrl || null,
      page_number: ev.pageNumber || null,
      raw_snippet: ev.rawSnippet,
      confidence_score: ev.confidenceScore || 0.95,
      is_verified: false,
    }));

    const { error: evErr } = await supabaseAdmin
      .from('school_evidence')
      .insert(evidenceRows);

    if (evErr) {
      console.error('Error inserting school evidence:', evErr);
    }
  }

  // 3. Update top-level school fields if present
  const schoolUpdates: any = { updated_at: new Date().toISOString() };
  if (extracted.extractedRubric.cutoffs.avgCgpa) {
    schoolUpdates.avg_gpa = extracted.extractedRubric.cutoffs.avgCgpa;
  }
  if (extracted.extractedRubric.cutoffs.avgDatAa) {
    schoolUpdates.dat_avg = extracted.extractedRubric.cutoffs.avgDatAa;
  }
  if (extracted.extractedRubric.cutoffs.minCgpa) {
    schoolUpdates.min_cgpa_5th = extracted.extractedRubric.cutoffs.minCgpa;
  }
  if (extracted.extractedRubric.cutoffs.minDatAa) {
    schoolUpdates.min_dat_5th = extracted.extractedRubric.cutoffs.minDatAa;
  }
  if (extracted.extractedRubric.holisticFactors.communityCollegeAccepted !== undefined) {
    schoolUpdates.cc_credits = extracted.extractedRubric.holisticFactors.communityCollegeAccepted;
  }

  await supabaseAdmin
    .from('schools')
    .update(schoolUpdates)
    .eq('id', targetSchoolId);

  return {
    schoolId: targetSchoolId || '',
    schoolName: extracted.schoolName,
    sourceType: meta.sourceType,
    sourceName: meta.sourceName,
    sourceUrl: meta.sourceUrl,
    extractedRubric: extracted.extractedRubric,
    evidenceList: extracted.evidenceList,
  };
}
