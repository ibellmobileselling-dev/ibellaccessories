import { createServerFn } from "@tanstack/react-start";
import { existsSync } from "node:fs";
import { requireActiveUser } from "@/lib/firebaseAdmin";

type RenderPdfInput = {
  callerIdToken: string;
  html: string;
  landscape: boolean;
  pageWidthMm?: number;
};

const LOCAL_CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => !!p);

/** Shared by every PDF-producing server function below — launches headless
 * Chromium and renders `html` to raw PDF bytes. Not exported: callers only
 * ever want one of the two response shapes below (Blob for download/share,
 * base64 for the WhatsApp send), never these raw bytes directly. */
type PdfBrowser = Awaited<ReturnType<typeof import("puppeteer-core").launch>>;

/** Launch Chromium, run `fn`, always close.
 *
 * Launching is by far the most expensive part of producing a PDF — on
 * Vercel it means starting a real browser binary, several seconds even when
 * the function is warm. Anything rendering more than one document must do
 * it inside ONE of these, not one per document. */
async function withBrowser<T>(fn: (browser: PdfBrowser) => Promise<T>): Promise<T> {
  const chromium = (await import("@sparticuz/chromium")).default;
  const { launch } = await import("puppeteer-core");

  // On Vercel/Lambda there's no system browser, so we ship a
  // Linux-compatible Chromium binary via @sparticuz/chromium. Locally
  // (Windows/Mac dev machines) that binary can't run — fall back to
  // whatever desktop Chrome/Edge is already installed.
  const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localChrome = LOCAL_CHROME_CANDIDATES.find((p) => existsSync(p));
  const executablePath =
    isServerless || !localChrome ? await chromium.executablePath() : localChrome;

  const browser = await launch({
    args: isServerless || !localChrome ? chromium.args : [],
    executablePath,
    headless: true,
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/** Render one document in an already-running browser. */
async function renderInBrowser(
  browser: PdfBrowser,
  html: string,
  landscape: boolean,
  pageWidthMm?: number,
): Promise<Buffer> {
  {
    const page = await browser.newPage();
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "load" });

    let pdf: Buffer | Uint8Array;
    if (pageWidthMm) {
      // Thermal receipts (80mm/58mm rolls) use `@page { size: Xmm auto }` —
      // "auto" tells a real printer to cut after the content ends. Puppeteer
      // silently ignores that keyword and falls back to full A4 regardless
      // of `preferCSSPageSize`, so instead of relying on the CSS @page size
      // at all here, measure the actually-rendered content height ourselves
      // and pass explicit page dimensions — the one thing that reliably
      // works, verified directly against this exact Puppeteer version.
      //
      // document.body.scrollHeight doesn't work for this: the printed
      // element carries the `.print-visible`/`.print-area` class, and
      // styles.css's @media print rules force it to `position: absolute`
      // (a standard print-CSS technique — hide everything, absolutely
      // position just the printable content). An absolutely positioned
      // element doesn't contribute to its static parent's scrollHeight, so
      // body's height came back unrelated to the actual content — measure
      // the printed element itself instead.
      // Leftover @page rules (the thermal one, and styles.css's global A4
      // default) still confuse Chromium's print pipeline even though
      // `width`/`height` below are passed explicitly and preferCSSPageSize
      // is off — verified directly: with these rules left in place, content
      // renders correctly in isolation but the page.pdf() output leaves the
      // bottom ~70% of the page blank; deleting them via the CSSOM before
      // calling page.pdf() is what actually fixes it.
      await page.evaluate(() => {
        const scan = (owner: CSSStyleSheet | CSSMediaRule) => {
          try {
            const rules = owner.cssRules;
            for (let i = rules.length - 1; i >= 0; i--) {
              const rule = rules[i];
              if (rule.type === CSSRule.PAGE_RULE) owner.deleteRule(i);
              else if (rule.type === CSSRule.MEDIA_RULE) scan(rule as unknown as CSSMediaRule);
            }
          } catch {
            // Cross-origin stylesheet — can't touch its rules, skip it.
          }
        };
        for (const sheet of Array.from(document.styleSheets)) scan(sheet);
      });

      const heightPx = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(".print-visible, .print-area");
        return (el ?? document.body).getBoundingClientRect().height;
      });
      // Small buffer only — the measurement itself is precise (verified
      // directly against real output), a big cushion here just reintroduces
      // the dead-space-at-the-bottom look this was meant to eliminate.
      const heightMm = Math.ceil((heightPx * 25.4) / 96) + 2;
      pdf = await page.pdf({
        width: `${pageWidthMm}mm`,
        height: `${heightMm}mm`,
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      });
    } else {
      pdf = await page.pdf({
        format: "a4",
        landscape,
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      });
    }
    // Close the tab (not the browser) so a batch doesn't accumulate pages.
    await page.close();
    return Buffer.from(pdf);
  }
}

/** Single-document convenience wrapper — one launch, one render. */
async function renderPdfBuffer(
  html: string,
  landscape: boolean,
  pageWidthMm?: number,
): Promise<Buffer> {
  return withBrowser((b) => renderInBrowser(b, html, landscape, pageWidthMm));
}

const validateRenderInput = (data: unknown): RenderPdfInput => {
  const d = data as Partial<RenderPdfInput>;
  if (typeof d?.callerIdToken !== "string" || !d.callerIdToken)
    throw new Error("Not authenticated");
  if (typeof d.html !== "string" || !d.html) throw new Error("html is required");
  return {
    callerIdToken: d.callerIdToken,
    html: d.html,
    landscape: !!d.landscape,
    pageWidthMm: typeof d.pageWidthMm === "number" ? d.pageWidthMm : undefined,
  };
};

/** Renders a self-contained HTML document (markup + inlined CSS, no scripts)
 * to a real vector PDF using headless Chromium — the same rendering engine
 * and print CSS the "Print" button already uses, so text stays crisp at any
 * zoom instead of being a raster screenshot. */
export const renderPdfServerFn = createServerFn({ method: "POST" })
  .validator(validateRenderInput)
  .handler(async ({ data }) => {
    // Anyone on the internet can POST to a server fn — without this check
    // the endpoint was an unauthenticated headless-Chromium-as-a-service
    // (SSRF via subresource fetches in attacker HTML + free compute).
    await requireActiveUser(data.callerIdToken);
    const pdf = await renderPdfBuffer(data.html, data.landscape, data.pageWidthMm);
    return new Response(new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), {
      headers: { "Content-Type": "application/pdf" },
    });
  });

type RenderPdfBatchInput = {
  callerIdToken: string;
  docs: { html: string; landscape: boolean; pageWidthMm?: number }[];
};

/** Hard ceiling per request: the response carries every PDF as base64
 * (~1.33x their real size) and a serverless response has a few-MB limit, so
 * the client chunks longer runs rather than losing the lot to one oversized
 * reply. */
const MAX_BATCH = 10;

const validateBatchInput = (data: unknown): RenderPdfBatchInput => {
  const d = data as Partial<RenderPdfBatchInput>;
  if (typeof d?.callerIdToken !== "string" || !d.callerIdToken)
    throw new Error("Not authenticated");
  if (!Array.isArray(d.docs) || !d.docs.length) throw new Error("docs is required");
  if (d.docs.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} documents per request`);
  return {
    callerIdToken: d.callerIdToken,
    docs: d.docs.map((doc) => {
      if (typeof doc?.html !== "string" || !doc.html) throw new Error("each doc needs html");
      return {
        html: doc.html,
        landscape: !!doc.landscape,
        pageWidthMm: typeof doc.pageWidthMm === "number" ? doc.pageWidthMm : undefined,
      };
    }),
  };
};

/**
 * Render SEVERAL documents from ONE Chromium launch.
 *
 * The bulk party-ledger export used to call renderPdfServerFn once per
 * party, which meant starting a whole browser per party — the launch, not
 * the rendering, is what made a ten-party download feel like it had hung.
 * One launch and N tabs turns that into roughly one browser start plus a
 * little per document.
 */
export const renderPdfBatchServerFn = createServerFn({ method: "POST" })
  .validator(validateBatchInput)
  .handler(async ({ data }) => {
    // Same gate as every other server fn — this is still headless Chromium
    // on demand, and a batch endpoint is a bigger prize, not a smaller one.
    await requireActiveUser(data.callerIdToken);
    const out = await withBrowser(async (browser) => {
      const pdfs: string[] = [];
      for (const doc of data.docs) {
        const buf = await renderInBrowser(browser, doc.html, doc.landscape, doc.pageWidthMm);
        pdfs.push(buf.toString("base64"));
      }
      return pdfs;
    });
    return { pdfsBase64: out };
  });

/** Same rendering as renderPdfServerFn, but returns base64 JSON instead of a
 * Blob Response — for callers that need to hand the bytes to another server
 * (e.g. the WhatsApp send service), which can't consume a fetch Response. */
export const renderPdfBase64ServerFn = createServerFn({ method: "POST" })
  .validator(validateRenderInput)
  .handler(async ({ data }) => {
    await requireActiveUser(data.callerIdToken);
    const pdf = await renderPdfBuffer(data.html, data.landscape, data.pageWidthMm);
    return { pdfBase64: pdf.toString("base64") };
  });
