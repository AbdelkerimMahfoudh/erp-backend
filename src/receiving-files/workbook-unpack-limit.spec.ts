import JSZip from 'jszip';
import { BadRequestException } from '@nestjs/common';
import { assertWorkbookUnpacksWithin, readWorkbook } from './xlsx-reader';

/**
 * A workbook is refused once its parts unpack past a bound, before the excess is held (reviews BE5-06, NW2-02,
 * 2026-10-16).
 *
 * The cell limit was counted on XML already unpacked, so a zip bomb — a few kilobytes that inflate to gigabytes —
 * exhausted the API first, in the delivery reader and in the opening-inventory import (exceljs unzips on its own).
 * Here a part inflating to 4 MB is measured against a 1 MB bound, so the test holds megabytes, not gigabytes.
 */

const MB = 1024 * 1024;

async function workbook(sheetXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const padded = () => `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData>${' '.repeat(4 * MB)}</worksheet>`;

describe('a workbook that unpacks too far', () => {
  it('the delivery reader refuses it as file_too_large', async () => {
    const file = await workbook(padded());
    expect(file.length).toBeLessThan(64 * 1024); // a few kilobytes on the wire
    const caught = await readWorkbook(file, 1 * MB).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({ code: 'file_too_large' });
  });

  it('the pre-check for exceljs refuses it too', async () => {
    const file = await workbook(padded());
    await expect(assertWorkbookUnpacksWithin(file, 1 * MB)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an ordinary workbook within the bound still reads', async () => {
    const file = await workbook('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>IMEI</t></is></c></row></sheetData></worksheet>');
    await expect(assertWorkbookUnpacksWithin(file, 1 * MB)).resolves.toBeUndefined();
    const sheets = await readWorkbook(file, 1 * MB);
    expect(sheets[0].rows[0][0].text).toBe('IMEI');
  });
});
