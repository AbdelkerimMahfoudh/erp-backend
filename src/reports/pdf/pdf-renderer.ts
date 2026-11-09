import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Browser } from 'puppeteer-core';

/** A4 with the app's margins (lib/report-pdf.ts: 14 × 16 mm). */
const PDF_OPTIONS = {
  format: 'A4' as const,
  printBackground: true,
  margin: { top: '14mm', bottom: '14mm', left: '16mm', right: '16mm' },
};
const RENDER_TIMEOUT_MS = 30_000;

/**
 * HTML → PDF with the image's headless Chromium (PDF_CHROMIUM_PATH). One browser, started on first use and
 * reused; one page per PDF; renders one at a time. The page is printed offline: every request it makes is
 * refused, so a report never fetches anything.
 */
@Injectable()
export class PdfRenderer implements OnModuleDestroy {
  private readonly logger = new Logger(PdfRenderer.name);
  private browser: Promise<Browser> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private readonly executablePath = process.env.PDF_CHROMIUM_PATH || undefined;

  get available(): boolean {
    return !!this.executablePath;
  }

  render(html: string): Promise<Buffer> {
    const run = this.queue.then(() => this.renderNow(html));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async renderNow(html: string): Promise<Buffer> {
    if (!this.executablePath) throw new Error('PDF rendering is not configured (PDF_CHROMIUM_PATH)');
    const browser = await this.launch();
    const page = await browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith('data:') ? r.continue() : r.abort()));
      await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
      return Buffer.from(await page.pdf({ ...PDF_OPTIONS, timeout: RENDER_TIMEOUT_MS }));
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = import('puppeteer-core')
        .then((p) =>
          p.launch({
            executablePath: this.executablePath,
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'],
          }),
        )
        .then((b) => {
          b.on('disconnected', () => (this.browser = null));
          return b;
        })
        .catch((e: unknown) => {
          this.browser = null;
          this.logger.warn(`Chromium did not start: ${(e as Error).message}`);
          throw e;
        });
    }
    return this.browser;
  }

  async onModuleDestroy(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b).close().catch(() => undefined);
  }
}
