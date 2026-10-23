// Render guide.html to docs/user-guide.pdf with the system Chrome.
//   npm i puppeteer-core --no-save   (if missing)
//   node docs/guide/pdf.mjs
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

const dir = new URL("./", import.meta.url).pathname;
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new" });
const page = await browser.newPage();
await page.goto(`file://${dir}guide.html`, { waitUntil: "networkidle0" });
await page.pdf({
  path: process.argv[2] ?? `${dir}../user-guide.pdf`,
  format: "A4",
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate: '<div style="font-size:7.5pt;color:#8a938e;width:100%;padding:0 15mm;display:flex;justify-content:space-between;font-family:-apple-system,sans-serif"><span>MJWaits User Guide</span><span class="pageNumber"></span></div>',
});
await browser.close();
