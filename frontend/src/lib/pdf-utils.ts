/**
 * Injects a "Download PDF" button and auto-print trigger into an HTML report string,
 * then opens it in a new browser tab.
 *
 * The button is hidden in @media print so it doesn't appear in the saved PDF.
 * window.print() is auto-triggered after a short delay so the browser's
 * "Save as PDF" dialog opens immediately when the tab loads.
 */
export function openReportForDownload(html: string): void {
  const controls = `
<div id="__pdf_toolbar" style="
  position:fixed;top:0;left:0;right:0;z-index:99999;
  background:#111;color:#fff;
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 20px;font-family:Arial,Helvetica,sans-serif;font-size:13px;
  box-shadow:0 2px 8px rgba(0,0,0,.4);
">
  <span style="font-weight:700;letter-spacing:.3px">RPMCares Report Preview</span>
  <div style="display:flex;gap:10px">
    <button onclick="window.print()" style="
      background:#fff;color:#000;border:none;padding:8px 20px;
      font-size:13px;font-weight:700;border-radius:6px;cursor:pointer;
    ">⬇ Download PDF</button>
    <button onclick="window.close()" style="
      background:transparent;color:#aaa;border:1px solid #444;
      padding:8px 14px;font-size:13px;border-radius:6px;cursor:pointer;
    ">✕ Close</button>
  </div>
</div>
<style>
  /* Push page content below the toolbar */
  body { padding-top: 52px !important; }
  @media print {
    #__pdf_toolbar { display: none !important; }
    body { padding-top: 0 !important; }
  }
</style>
<script>
  // Auto-open the print/save dialog once the page is ready
  window.addEventListener('load', function () {
    setTimeout(function () { window.print(); }, 600);
  });
</script>`;

  // Insert toolbar just after <body> (or before </body> as fallback)
  const injected = html.includes('<body')
    ? html.replace(/(<body[^>]*>)/i, `$1${controls}`)
    : html.replace('</body>', `${controls}</body>`);

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(injected);
    win.document.close();
  }
}
