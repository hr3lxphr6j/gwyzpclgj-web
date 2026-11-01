// Guards the 5 original user-facing error strings against silent edits. The
// wording (including the full-width punctuation) is part of the behaviour
// contract: it must match the original tool byte for byte. Code 6 is the
// web-only unsupported-format extension.
import assert from 'node:assert/strict';
import { MESSAGES, messageForCode } from '../web/messages.js';

const EXPECTED = {
  1: '打开照片文件类型不是JPG/JPEG格式，请选择JPG/JPEG格式照片文件。',
  2: '打开照片文件像素数低。请选择高于或符合像素数要求的照片文件。',
  3: '打开照片文件背景不符合要求。请选择白色或蓝色背景照片文件。',
  4: '打开照片文件人像头部比例不符合要求。请选择头部比例适当的照片文件。',
  5: '打开照片文件不符合要求。请选择正面人像标准证件照片文件。',
  6: '打开照片文件格式不受支持。请选择JPG/JPEG、PNG、WebP、BMP或TIFF格式照片文件。',
};

const codes = Object.keys(EXPECTED).map(Number);
assert.deepEqual(
  Object.keys(MESSAGES).map(Number).sort((a, b) => a - b),
  codes,
  'MESSAGES must contain exactly codes 1-6',
);

for (const code of codes) {
  assert.equal(
    MESSAGES[code],
    EXPECTED[code],
    `MESSAGES[${code}] must match the original wording exactly`,
  );
  assert.equal(
    messageForCode(code),
    EXPECTED[code],
    `messageForCode(${code}) must resolve to the same wording`,
  );
}

assert.equal(messageForCode(0), null, 'code 0 means success and has no message');
assert.equal(messageForCode(7), null, 'unknown codes have no user-facing text');

console.log(`messages: ${codes.length}/${codes.length} exact strings verified`);
