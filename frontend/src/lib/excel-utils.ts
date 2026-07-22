import * as XLSX from 'xlsx';

function downloadBlob(data: ArrayBuffer, filename: string) {
  const blob = new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function autoWidth(ws: XLSX.WorkSheet, rows: any[][]): void {
  const colWidths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      const len = String(cell ?? '').length;
      if (!colWidths[i] || colWidths[i] < len) colWidths[i] = len;
    });
  }
  ws['!cols'] = colWidths.map(w => ({ wch: Math.min(w + 2, 50) }));
}

export function exportQueueXlsx(records: any[], month: string): void {
  const monthLabel = new Date(month + '-01').toLocaleString('en-US', {
    month: 'long', year: 'numeric',
  });

  const header = [
    'Patient Name', 'Clinic', 'Program', 'Insurance Type',
    'CPT Code', 'Readings', 'Review Min', 'Cycle Start', 'Cycle End',
    'Status', 'Projected ($)',
  ];

  const rows = records.map(r => [
    r.patient_name ?? '',
    r.clinic_name  ?? '',
    r.program      ?? '',
    r.insurance_type ?? '',
    r.cpt_code     ?? '',
    r.reading_count ?? 0,
    r.total_minutes ?? 0,
    r.cycle_start  ?? '',
    r.cycle_end    ?? '',
    r.status       ?? '',
    r.projected_amount != null ? Number(r.projected_amount.toFixed(2)) : 0,
  ]);

  const totalProjected = records.reduce((s, r) => s + (r.projected_amount ?? 0), 0);
  const summary = [
    ['Billing Period', monthLabel],
    ['Generated',      new Date().toLocaleString('en-US')],
    ['Total Records',  records.length],
    ['Projected Revenue', `$${totalProjected.toFixed(2)}`],
    [],
  ];

  const allRows = [...summary, header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(allRows);
  autoWidth(ws, allRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Billing Queue');

  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(buf, `billing-queue-${month}.xlsx`);
}

export function exportClinicXlsx(report: any): void {
  const header = [
    'Patient Name', 'DOB', 'MRN', 'Program', 'Insurance Type',
    'CPT Codes', 'Readings', 'Review Min', 'Cycle Start', 'Cycle End', 'Projected ($)',
  ];

  const rows = (report.patients ?? []).map((p: any) => [
    p.full_name      ?? '',
    p.dob            ?? '',
    p.mrn            ?? '',
    p.program        ?? '',
    p.insurance_type ?? p.insurance_payer ?? '',
    (p.cptCodes ?? []).join(', '),
    p.totalReadings  ?? 0,
    p.totalMinutes   ?? 0,
    p.cycle_start    ?? '',
    p.cycle_end      ?? '',
    p.totalProjected != null ? Number(p.totalProjected.toFixed(2)) : 0,
  ]);

  const totals = report.totals ?? {};
  const summary = [
    ['Clinic',         report.clinic?.name ?? ''],
    ['Period',         report.period?.label ?? ''],
    ['Generated',      new Date().toLocaleString('en-US')],
    ['Total Patients', totals.patients ?? 0],
    ['Total Readings', totals.totalReadings ?? 0],
    ['Total Min',      totals.totalMinutes ?? 0],
    ['Threshold Met',  totals.thresholdMet ?? 0],
    ['Projected Revenue', `$${(totals.totalProjected ?? 0).toFixed(2)}`],
    [],
  ];

  const allRows = [...summary, header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(allRows);
  autoWidth(ws, allRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Clinic Report');

  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const slug = (report.clinic?.name ?? 'clinic').toLowerCase().replace(/\s+/g, '-');
  downloadBlob(buf, `clinic-report-${slug}-${report.period?.start ?? ''}.xlsx`);
}
