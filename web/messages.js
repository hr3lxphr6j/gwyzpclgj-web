// Error codes returned by photo_process mapped to the original tool's exact
// wording. UI code and tests both import this file so the strings cannot drift.
export const MESSAGES = {
  1: '打开照片文件类型不是JPG/JPEG格式，请选择JPG/JPEG格式照片文件。',
  2: '打开照片文件像素数低。请选择高于或符合像素数要求的照片文件。',
  3: '打开照片文件背景不符合要求。请选择白色或蓝色背景照片文件。',
  4: '打开照片文件人像头部比例不符合要求。请选择头部比例适当的照片文件。',
  5: '打开照片文件不符合要求。请选择正面人像标准证件照片文件。',
};

export function messageForCode(code) {
  return MESSAGES[code] ?? null;
}
