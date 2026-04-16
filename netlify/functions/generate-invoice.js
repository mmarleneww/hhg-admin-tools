/**
 * Netlify Function: generate-invoice
 * Generates HaoHaoGuo Realty invoice PDF using Python/reportlab
 * POST body: { invType, invNumber, invDate, to, toAddr, attn, agencyLic, lines }
 * Returns: PDF binary
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Write Python script to temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-'));
  const pyFile = path.join(tmpDir, 'gen.py');
  const outFile = path.join(tmpDir, 'invoice.pdf');
  const dataFile = path.join(tmpDir, 'data.json');

  fs.writeFileSync(dataFile, JSON.stringify(data));

  const pyScript = `
import json, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from io import BytesIO

with open('${dataFile}') as f:
    data = json.load(f)

def generate(data):
    buf = BytesIO()
    W, H = A4
    c = canvas.Canvas(buf, pagesize=A4)

    RED = colors.HexColor('#D42B2B')
    DARK = colors.HexColor('#1A1A1A')
    GRAY = colors.HexColor('#5A5A5A')
    LINE = colors.HexColor('#E8E5E0')
    margin = 25*mm
    content_w = W - 2*margin

    y = H - 20*mm

    # Company header (right-aligned)
    c.setFont('Helvetica-Bold', 14)
    c.setFillColor(RED)
    c.drawRightString(W - margin, y, 'HaoHaoGuo Realty Pte. Ltd.')

    y -= 5*mm
    c.setFont('Helvetica', 8)
    c.setFillColor(GRAY)
    c.drawRightString(W - margin, y, '991C Alexandra Road #01-13B Singapore 119971')
    y -= 4.5*mm
    c.drawRightString(W - margin, y, 'Licence No.: L3010896E            ACRA No.: 201938308M')
    y -= 4.5*mm
    c.drawRightString(W - margin, y, 'Email: admin@haohaoguo.com            Contact No: +65-85907523')
    y -= 4.5*mm
    c.setFillColor(RED)
    c.drawRightString(W - margin, y, 'www.HaoHaoGuo.com')

    y -= 6*mm
    c.setStrokeColor(LINE)
    c.setLineWidth(0.5)
    c.line(margin, y, W - margin, y)

    # Invoice No + Date on right (above TO block)
    inv_no_y = y - 8*mm
    c.setFont('Helvetica', 8)
    c.setFillColor(GRAY)
    c.drawRightString(W - margin - 30*mm, inv_no_y, 'Invoice No.:')
    c.setFont('Helvetica-Bold', 8)
    c.setFillColor(DARK)
    c.drawString(W - margin - 28*mm, inv_no_y, data.get('invNumber', ''))
    inv_no_y -= 5*mm
    c.setFont('Helvetica', 8)
    c.setFillColor(GRAY)
    c.drawRightString(W - margin - 30*mm, inv_no_y, 'Date:')
    c.setFont('Helvetica', 8)
    c.setFillColor(DARK)
    c.drawString(W - margin - 28*mm, inv_no_y, data.get('invDate', ''))

    # INVOICE title
    c.setFont('Helvetica-Bold', 20)
    c.setFillColor(RED)
    c.drawRightString(W - margin, inv_no_y - 2*mm, 'INVOICE')

    # TO block
    y -= 8*mm
    c.setFont('Helvetica-Bold', 8)
    c.setFillColor(GRAY)
    c.drawString(margin, y, 'TO:')
    c.setFont('Helvetica-Bold', 10)
    c.setFillColor(DARK)
    c.drawString(margin + 15*mm, y, data.get('to', ''))

    if data.get('toAddr'):
        # wrap long addresses
        addr_parts = data['toAddr'].split(',')
        for part in addr_parts:
            part = part.strip()
            if part:
                y -= 4.5*mm
                c.setFont('Helvetica', 8)
                c.setFillColor(DARK)
                c.drawString(margin + 15*mm, y, part + (',' if part != addr_parts[-1].strip() else ''))

    if data.get('agencyLic'):
        y -= 4.5*mm
        c.setFont('Helvetica', 8)
        c.setFillColor(GRAY)
        c.drawString(margin, y, 'Licence No.:')
        c.setFillColor(DARK)
        c.drawString(margin + 22*mm, y, data['agencyLic'])

    if data.get('attn'):
        y -= 4.5*mm
        c.setFont('Helvetica', 8)
        c.setFillColor(GRAY)
        c.drawString(margin, y, 'ATTN:')
        c.setFillColor(DARK)
        c.drawString(margin + 15*mm, y, data['attn'])

    # Table header
    y -= 12*mm
    c.setFillColor(colors.HexColor('#F7F6F4'))
    c.rect(margin, y - 1.5*mm, content_w, 7*mm, fill=1, stroke=0)
    c.setFont('Helvetica-Bold', 8)
    c.setFillColor(GRAY)
    c.drawString(margin + 5*mm, y + 1*mm, 'Description')
    c.drawRightString(W - margin - 30*mm, y + 1*mm, 'Rate')
    c.drawRightString(W - margin - 18*mm, y + 1*mm, 'Unit')
    c.drawRightString(W - margin, y + 1*mm, 'Amount')

    y -= 8*mm

    lines = data.get('lines', [])
    for i, line in enumerate(lines):
        desc = line.get('description', '')
        detail = line.get('detail', '')
        amt = float(line.get('amount', 0) or 0)

        c.setFont('Helvetica', 9)
        c.setFillColor(DARK)
        c.drawString(margin, y, str(i + 1))
        c.setFont('Helvetica-Bold', 9)
        c.drawString(margin + 8*mm, y, desc)

        amt_str = '{:,.2f}'.format(amt)
        c.setFont('Helvetica', 9)
        c.drawRightString(W - margin - 30*mm, y, amt_str)
        c.drawRightString(W - margin - 18*mm, y, '1')
        c.drawRightString(W - margin, y, amt_str)

        y -= 5*mm

        if detail:
            c.setFont('Helvetica', 8)
            c.setFillColor(GRAY)
            for dl in detail.split('\\n'):
                dl = dl.strip()
                if dl:
                    c.drawString(margin + 8*mm, y, dl)
                    y -= 4.5*mm
            c.setFillColor(DARK)

        y -= 4*mm

    # Totals
    y -= 4*mm
    c.setStrokeColor(LINE)
    c.setLineWidth(0.5)
    c.line(W - margin - 65*mm, y + 3*mm, W - margin, y + 3*mm)

    gst_base = sum(float(l.get('amount', 0) or 0) for l in lines if l.get('hasGst', True))
    no_gst   = sum(float(l.get('amount', 0) or 0) for l in lines if not l.get('hasGst', True))
    gst_amt  = round(gst_base * 0.09, 2)
    total    = gst_base + gst_amt + no_gst

    def row(label, val, bold=False, color=DARK):
        nonlocal y
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 9 if bold else 8)
        c.setFillColor(color)
        c.drawRightString(W - margin - 32*mm, y, label)
        c.drawString(W - margin - 28*mm, y, 'SGD')
        c.drawRightString(W - margin, y, '{:,.2f}'.format(val))
        y -= 5.5*mm

    if gst_base > 0:
        row('GST', gst_amt, color=GRAY)
    row('TOTAL', total, bold=True, color=RED)

    # Footer
    y -= 8*mm
    c.setFont('Helvetica-Oblique', 7.5)
    c.setFillColor(GRAY)
    c.drawString(margin, y, 'This is a Computer Generated Invoice, No signature is required.')

    y -= 7*mm
    c.setFont('Helvetica-Bold', 8)
    c.setFillColor(DARK)
    c.drawString(margin, y, 'Payment Methods')

    y -= 5*mm
    pmt = [
        ('Bank:', 'United Overseas Bank Limited'),
        ('Account Name:', 'HaoHaoGuo Realty Pte. Ltd.'),
        ('Account No.:', '4513118281'),
        ('Bank Code:', '7375      Branch Code: 001'),
        ('Swift Code:', 'UOVBSGSG'),
        ('PayNow UEN:', '201938308M'),
    ]
    for label, val in pmt:
        c.setFont('Helvetica-Bold', 8)
        c.setFillColor(GRAY)
        c.drawString(margin, y, label)
        c.setFont('Helvetica', 8)
        c.setFillColor(DARK)
        c.drawString(margin + 28*mm, y, val)
        y -= 4.5*mm

    y -= 5*mm
    c.setFont('Helvetica-Bold', 9)
    c.setFillColor(RED)
    c.drawCentredString(W/2, y, 'Thank you for your support!')

    c.save()
    buf.seek(0)
    return buf.read()

pdf = generate(data)
with open('${outFile}', 'wb') as f:
    f.write(pdf)
print('OK')
`;

  fs.writeFileSync(pyFile, pyScript);

  try {
    execSync(`python3 "${pyFile}"`, { timeout: 30000 });

    const pdfBuffer = fs.readFileSync(outFile);
    const base64 = pdfBuffer.toString('base64');

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${data.invNumber || 'invoice'}.pdf"`,
        'Content-Transfer-Encoding': 'base64',
      },
      body: base64,
      isBase64Encoded: true,
    };

  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'PDF generation failed' }),
    };
  }
};
