/**
 * Multipart limits for every upload route (docs/48 control 8).
 *
 * Each route sends one file and a handful of short text fields. Capping the
 * file's size alone left the rest of the form unbounded: any number of parts,
 * of fields and of files, and field names of any length — the shapes behind
 * multer's denial-of-service advisories. These limits refuse such a form
 * before it is buffered, whatever the version of multer underneath.
 */
export function uploadLimits(fileSize: number) {
  return {
    fileSize,
    files: 1,
    fields: 8,
    parts: 9,
    fieldNameSize: 64,
    fieldSize: 64 * 1024,
  };
}
