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

const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  soft: '#94a3b8',
  line: '#e2e8f0',
  card: '#f8fafc',
  accent: '#4f46e5',
  accentSoft: '#eef2ff',
  white: '#ffffff',
};

function drawHeaderBar(doc: PDFKit.PDFDocument, title: string, subtitle: string) {
  const { width } = doc.page;
  doc.save();
  doc.rect(0, 0, width, 72).fill(COLORS.accent);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(18).text(title, 50, 22, {
    width: width - 100,
  });
  doc.font('Helvetica').fontSize(9).fillColor('#c7d2fe').text(subtitle, 50, 46, {
    width: width - 100,
  });
  doc.restore();
  doc.y = 92;
}

function sectionTitle(doc: PDFKit.PDFDocument, label: string) {
  const y = doc.y;
  doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(11).text(label.toUpperCase(), 50, y);
  doc
    .moveTo(50, doc.y + 4)
    .lineTo(doc.page.width - 50, doc.y + 4)
    .strokeColor(COLORS.line)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.8);
  doc.fillColor(COLORS.ink);
}

function kvPair(doc: PDFKit.PDFDocument, label: string, value: unknown, x: number, width: number) {
  const text = value === null || value === undefined || value === '' ? '—' : String(value);
  const startY = doc.y;
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(label.toUpperCase(), x, startY, {
    width,
  });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10).text(text, x, startY + 12, {
    width,
  });
  return startY + 34;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - 60) {
    doc.addPage();
    doc.y = 50;
  }
}

export async function buildStudentProfilePdf(input: StudentProfilePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 50,
      size: 'LETTER',
      bufferPages: true,
      info: {
        Title: `${input.student.name || 'Student'} — Profile`,
        Author: 'Dental CRM',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(Buffer.from(c)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const s = input.student;
    const generatedAt = new Date().toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const location = [s.state, s.zip_code, s.country].filter(Boolean).join(', ');

    drawHeaderBar(doc, 'Student Profile', `Generated ${generatedAt}`);

    // Identity card
    const cardTop = doc.y;
    const cardHeight = 78;
    doc.roundedRect(50, cardTop, doc.page.width - 100, cardHeight, 8).fill(COLORS.card);
    doc
      .roundedRect(50, cardTop, 6, cardHeight, 3)
      .fill(COLORS.accent);

    doc
      .fillColor(COLORS.ink)
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(s.name || 'Student', 70, cardTop + 16, { width: 320 });
    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(10)
      .text(s.email || 'No email on file', 70, cardTop + 38, { width: 320 });
    doc
      .fillColor(COLORS.soft)
      .fontSize(9)
      .text(location || 'Location not set', 70, cardTop + 54, { width: 320 });

    // Strength badge
    const badgeX = doc.page.width - 150;
    doc.roundedRect(badgeX, cardTop + 14, 80, 50, 8).fill(COLORS.accentSoft);
    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(7)
      .text('STRENGTH', badgeX, cardTop + 20, { width: 80, align: 'center' });
    doc
      .fillColor(COLORS.accent)
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(s.strength_score != null ? String(s.strength_score) : '—', badgeX, cardTop + 34, {
        width: 80,
        align: 'center',
      });

    doc.y = cardTop + cardHeight + 24;

    sectionTitle(doc, 'Snapshot');
    const snapY = doc.y;
    const colW = (doc.page.width - 120) / 2;
    let leftY = snapY;
    let rightY = snapY;
    doc.y = leftY;
    leftY = kvPair(doc, 'Status', s.status, 50, colW);
    doc.y = leftY;
    leftY = kvPair(
      doc,
      'Applicant type',
      s.is_reapplicant ? 'Re-applicant' : 'First-time',
      50,
      colW,
    );
    doc.y = leftY;
    leftY = kvPair(doc, 'Application cycle', s.application_cycle, 50, colW);

    doc.y = rightY;
    rightY = kvPair(doc, 'Gender', s.gender, 50 + colW + 20, colW);
    doc.y = rightY;
    rightY = kvPair(doc, 'Ethnicity', s.ethnicity, 50 + colW + 20, colW);
    doc.y = rightY;
    rightY = kvPair(doc, 'Age', s.age, 50 + colW + 20, colW);
    doc.y = Math.max(leftY, rightY) + 8;

    sectionTitle(doc, 'Academics');
    const acadY = doc.y;
    doc.y = acadY;
    let aLeft = kvPair(
      doc,
      'GPA',
      s.gpa != null ? `${s.gpa}${s.gpa_verified ? ' · verified' : ' · unverified'}` : null,
      50,
      colW,
    );
    doc.y = aLeft;
    aLeft = kvPair(
      doc,
      'DAT overall',
      s.dat_score != null
        ? `${s.dat_score}${s.dat_verified ? ' · verified' : ' · unverified'}`
        : null,
      50,
      colW,
    );
    doc.y = aLeft;
    aLeft = kvPair(doc, 'DAT AA / TS', [s.dat_aa, s.dat_ts].filter((v) => v != null).join(' / ') || null, 50, colW);

    doc.y = acadY;
    let aRight = kvPair(doc, 'Undergrad', s.undergrad_institution, 50 + colW + 20, colW);
    doc.y = aRight;
    aRight = kvPair(doc, 'Degree', s.undergrad_degree, 50 + colW + 20, colW);
    doc.y = aRight;
    aRight = kvPair(doc, 'Grad year', s.undergrad_grad_year, 50 + colW + 20, colW);
    doc.y = Math.max(aLeft, aRight) + 8;

    sectionTitle(doc, 'Experiences');
    if (!input.experiences?.length) {
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10).text('No experiences recorded.');
      doc.moveDown();
    } else {
      for (const exp of input.experiences) {
        ensureSpace(doc, 48);
        const y = doc.y;
        doc.roundedRect(50, y, doc.page.width - 100, 40, 6).fill(COLORS.card);
        doc
          .fillColor(COLORS.ink)
          .font('Helvetica-Bold')
          .fontSize(10)
          .text(exp.title || 'Experience', 62, y + 8, { width: doc.page.width - 130 });
        doc
          .fillColor(COLORS.muted)
          .font('Helvetica')
          .fontSize(8)
          .text(
            [exp.category, exp.organization, exp.start_date, exp.end_date || 'Present']
              .filter(Boolean)
              .join('  ·  '),
            62,
            y + 22,
            { width: doc.page.width - 130 },
          );
        doc.y = y + 48;
      }
    }

    ensureSpace(doc, 60);
    sectionTitle(doc, 'Documents');
    if (!input.documents?.length) {
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10).text('No documents recorded.');
      doc.moveDown();
    } else {
      // Table header
      const tableX = 50;
      const widths = [220, 140, 120];
      const headers = ['Title', 'Type', 'Status'];
      let x = tableX;
      doc.fillColor(COLORS.accentSoft);
      doc.rect(tableX, doc.y, doc.page.width - 100, 22).fill(COLORS.accentSoft);
      doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(8);
      headers.forEach((h, i) => {
        doc.text(h.toUpperCase(), x + 8, doc.y + 7, { width: widths[i] - 12 });
        x += widths[i];
      });
      doc.y += 26;

      for (const d of input.documents) {
        ensureSpace(doc, 22);
        const rowY = doc.y;
        x = tableX;
        doc
          .moveTo(tableX, rowY + 18)
          .lineTo(doc.page.width - 50, rowY + 18)
          .strokeColor(COLORS.line)
          .stroke();
        const cells = [d.title || 'Document', d.type || '—', d.status || '—'];
        cells.forEach((cell, i) => {
          doc
            .fillColor(i === 0 ? COLORS.ink : COLORS.muted)
            .font(i === 0 ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(9)
            .text(cell, x + 8, rowY + 4, { width: widths[i] - 12, ellipsis: true });
          x += widths[i];
        });
        doc.y = rowY + 22;
      }
      doc.moveDown(0.5);
    }

    ensureSpace(doc, 60);
    sectionTitle(doc, 'Manual Dexterity');
    if (!input.dexterity?.length) {
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10).text('No dexterity activities recorded.');
    } else {
      for (const d of input.dexterity) {
        ensureSpace(doc, 56);
        doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10).text(d.activity || 'Activity');
        if (d.description) {
          doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text(d.description, {
            width: doc.page.width - 100,
          });
        }
        doc
          .fillColor(COLORS.soft)
          .font('Helvetica')
          .fontSize(8)
          .text(
            d.is_ongoing
              ? `Started ${d.start_date || '—'} · Ongoing`
              : `${d.start_date || '—'} → ${d.end_date || '—'}`,
          );
        doc.moveDown(0.6);
      }
    }

    // Footers on every page
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      const footerY = doc.page.height - 36;
      doc
        .moveTo(50, footerY - 8)
        .lineTo(doc.page.width - 50, footerY - 8)
        .strokeColor(COLORS.line)
        .stroke();
      doc
        .fillColor(COLORS.soft)
        .font('Helvetica')
        .fontSize(8)
        .text('Dental CRM · Confidential student profile', 50, footerY, {
          width: 300,
        });
      doc.text(`Page ${i + 1} of ${pageCount}`, 50, footerY, {
        align: 'right',
        width: doc.page.width - 100,
      });
    }

    doc.end();
  });
}
