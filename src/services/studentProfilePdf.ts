import PDFDocument from 'pdfkit';

export type StudentProfilePdfInput = {
  student: {
    name: string;
    email?: string | null;
    state?: string | null;
    zip_code?: string | null;
    country?: string | null;
    ethnicity?: string | null;
    gender?: string | null;
    age?: number | null;
    gpa?: number | null;
    dat_score?: number | null;
    dat_aa?: number | null;
    dat_ts?: number | null;
    gpa_verified?: boolean;
    dat_verified?: boolean;
    undergrad_institution?: string | null;
    undergrad_degree?: string | null;
    undergrad_grad_year?: string | null;
    strength_score?: number | null;
    status?: string | null;
    is_reapplicant?: boolean;
    application_cycle?: string | null;
  };
  experiences?: Array<{
    title?: string | null;
    category?: string | null;
    organization?: string | null;
    start_date?: string | null;
    end_date?: string | null;
  }>;
  documents?: Array<{
    title?: string | null;
    type?: string | null;
    status?: string | null;
  }>;
  dexterity?: Array<{
    activity?: string | null;
    description?: string | null;
    start_date?: string | null;
    end_date?: string | null;
    is_ongoing?: boolean;
  }>;
};

function line(doc: any, label: string, value: unknown) {
  const text = value === null || value === undefined || value === '' ? '—' : String(value);
  doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
  doc.font('Helvetica').text(text);
}

export async function buildStudentProfilePdf(input: StudentProfilePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(Buffer.from(c)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const s = input.student;

    doc.fontSize(20).font('Helvetica-Bold').text('Student Profile Export');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#64748b')
      .text(`Generated ${new Date().toLocaleString()}`);
    doc.fillColor('#000000');
    doc.moveDown();

    doc.fontSize(14).font('Helvetica-Bold').text(s.name || 'Student');
    doc.fontSize(10).font('Helvetica').fillColor('#475569').text(s.email || '');
    doc.fillColor('#000000');
    doc.moveDown();

    doc.fontSize(12).font('Helvetica-Bold').text('Snapshot');
    doc.moveDown(0.4);
    doc.fontSize(10);
    line(doc, 'Strength score', s.strength_score);
    line(doc, 'Status', s.status);
    line(doc, 'Applicant type', s.is_reapplicant ? 'Re-applicant' : 'First-time');
    line(doc, 'Application cycle', s.application_cycle);
    line(doc, 'Location', [s.state, s.zip_code, s.country].filter(Boolean).join(', '));
    line(doc, 'Gender', s.gender);
    line(doc, 'Ethnicity', s.ethnicity);
    line(doc, 'Age', s.age);
    doc.moveDown();

    doc.fontSize(12).font('Helvetica-Bold').text('Academics');
    doc.moveDown(0.4);
    doc.fontSize(10);
    line(doc, 'GPA', s.gpa != null ? `${s.gpa}${s.gpa_verified ? ' (verified)' : ' (unverified)'}` : null);
    line(doc, 'DAT overall', s.dat_score != null ? `${s.dat_score}${s.dat_verified ? ' (verified)' : ' (unverified)'}` : null);
    line(doc, 'DAT AA', s.dat_aa);
    line(doc, 'DAT TS', s.dat_ts);
    line(doc, 'Undergrad', s.undergrad_institution);
    line(doc, 'Degree', s.undergrad_degree);
    line(doc, 'Grad year', s.undergrad_grad_year);
    doc.moveDown();

    doc.fontSize(12).font('Helvetica-Bold').text('Experiences');
    doc.moveDown(0.4);
    doc.fontSize(10);
    if (!input.experiences?.length) {
      doc.font('Helvetica').text('No experiences recorded.');
    } else {
      for (const exp of input.experiences) {
        doc.font('Helvetica-Bold').text(exp.title || 'Experience');
        doc.font('Helvetica').text(
          [exp.category, exp.organization, exp.start_date, exp.end_date || 'Present']
            .filter(Boolean)
            .join(' · '),
        );
        doc.moveDown(0.4);
      }
    }
    doc.moveDown();

    doc.fontSize(12).font('Helvetica-Bold').text('Documents');
    doc.moveDown(0.4);
    doc.fontSize(10);
    if (!input.documents?.length) {
      doc.font('Helvetica').text('No documents recorded.');
    } else {
      for (const d of input.documents) {
        doc.font('Helvetica').text(`${d.title || 'Document'} — ${d.type || '—'} (${d.status || '—'})`);
      }
    }
    doc.moveDown();

    doc.fontSize(12).font('Helvetica-Bold').text('Manual Dexterity');
    doc.moveDown(0.4);
    doc.fontSize(10);
    if (!input.dexterity?.length) {
      doc.font('Helvetica').text('No dexterity activities recorded.');
    } else {
      for (const d of input.dexterity) {
        doc.font('Helvetica-Bold').text(d.activity || 'Activity');
        if (d.description) doc.font('Helvetica').text(d.description);
        doc.font('Helvetica').fillColor('#64748b').text(
          d.is_ongoing
            ? `Started ${d.start_date || '—'} · Ongoing`
            : `${d.start_date || '—'} → ${d.end_date || '—'}`,
        );
        doc.fillColor('#000000');
        doc.moveDown(0.4);
      }
    }

    doc.end();
  });
}
