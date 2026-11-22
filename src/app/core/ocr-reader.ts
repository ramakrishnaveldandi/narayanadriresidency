/**
 * Browser side of image import: decodes the image, runs the table pipeline from
 * ocr-table.ts and the Tesseract OCR engine (loaded lazily, only for admins).
 * Tesseract's worker, WASM core and English data are fetched from the jsDelivr CDN
 * on first use (a few MB) and cached by the browser afterwards.
 */
import { detectMonth } from './excel-import';
import {
  columnSegments,
  detectTariff,
  findHorizontalLines,
  findVerticalLines,
  gridToRows,
  rebuildGrid,
  reconcileRows,
  rowBands,
  toGray,
  wordsToGrid,
  type FixedCharges,
  type OcrWord,
  type ReadRow,
  type WaterTariff,
} from './ocr-table';

export interface ImageReadResult {
  rows: ReadRow[];
  tariff: WaterTariff;
  month: string | null;
  title: string;
}

export type ProgressFn = (message: string, fraction: number) => void;

export async function readSheetImage(
  data: ArrayBuffer,
  mime: string,
  opts: { tariff: WaterTariff; fixed: FixedCharges; knownFlats: string[]; fileName: string },
  progress: ProgressFn = () => undefined,
): Promise<ImageReadResult> {
  progress('Preparing image…', 0.05);
  const bitmap = await createImageBitmap(new Blob([data], { type: mime || 'image/jpeg' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const gray = toGray(ctx.getImageData(0, 0, bitmap.width, bitmap.height));

  const cols = columnSegments(findVerticalLines(gray), gray.width);
  const bands = rowBands(findHorizontalLines(gray), gray.height);
  if (cols.length < 4 || bands.length < 3) {
    throw new Error('Could not find the table grid in this image. Use a clear screenshot of the sheet (not a photo at an angle).');
  }
  const { image, cells } = rebuildGrid(gray, cols, bands);
  const grid = document.createElement('canvas');
  grid.width = image.width;
  grid.height = image.height;
  grid.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);

  progress('Loading text recognition (first time downloads a few MB)…', 0.15);
  const { createWorker, PSM } = await import('tesseract.js');
  const worker = await createWorker('eng', undefined, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') progress('Reading numbers…', 0.3 + m.progress * 0.6);
    },
  });
  try {
    // Title row (month) - letters allowed.
    const titleCanvas = document.createElement('canvas');
    const titleH = Math.min(gray.height, bands[0][1] + 2);
    titleCanvas.width = gray.width * 2;
    titleCanvas.height = titleH * 2;
    titleCanvas.getContext('2d')!.drawImage(canvas, 0, 0, gray.width, titleH, 0, 0, gray.width * 2, titleH * 2);
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    const title = (await worker.recognize(titleCanvas)).data.text.replace(/[*|_]+/g, ' ').replace(/\s+/g, ' ').trim();

    // Table cells - digits only, sparse layout, word positions mapped back to cells.
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      tessedit_char_whitelist: '0123456789.,',
      user_defined_dpi: '300',
    });
    const { data: res } = await worker.recognize(grid, {}, { blocks: true, text: false });
    const words: OcrWord[] = (res.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
    const rows = gridToRows(wordsToGrid(words, cells, bands.length, cols.length));
    if (!rows.length) throw new Error('No flat rows could be read from this image.');

    progress('Checking every flat against the meter readings…', 0.95);
    const tariff = detectTariff(rows, opts.tariff);
    const read = reconcileRows(rows, { tariff, fixed: opts.fixed, knownFlats: opts.knownFlats });
    return { rows: read, tariff, month: detectMonth(title, opts.fileName), title };
  } finally {
    await worker.terminate();
    bitmap.close();
  }
}
