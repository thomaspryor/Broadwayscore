'use strict';
// Shared JPEG, PNG and WebP header reader. Also used by the daily digest,
// whose checkout does not install sharp. Unknown headers fail closed there.
function getImageDimensions(buffer) {
  if (!buffer || buffer.length < 30) return null;
  try {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xFF) { offset++; continue; }
        const marker = buffer[offset + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
        const len = buffer.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
      return null;
    }
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
      const fourCC = buffer.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && buffer.length > 29) {
        const width = buffer.readUInt16LE(26) & 0x3FFF;
        const height = buffer.readUInt16LE(28) & 0x3FFF;
        return { width, height };
      }
      if (fourCC === 'VP8L' && buffer.length > 25) {
        const bits = buffer.readUInt32LE(21);
        const width = (bits & 0x3FFF) + 1;
        const height = ((bits >> 14) & 0x3FFF) + 1;
        return { width, height };
      }
      if (fourCC === 'VP8X' && buffer.length > 29) {
        const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
        const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
        return { width, height };
      }
    }
  } catch { }
  return null;
}

module.exports = { getImageDimensions };
