// Files the app hands over - the 局 sheet's CSV and the Stats pictures: a
// day stamp and a safe name for them, and the download itself.

// "2026-11-02": the local day of a time, for a file name.
export function dayStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A name or label made safe for a file name: what a file system won't take
// (and runs of spaces) become a dash.
export function fileSafe(text: string): string {
  return text
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Save a file the plain way: a link to it, clicked.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
