// 学生成长档案工作台 —— 极简 multipart/form-data 解析器（零依赖）
// 配合 express.raw({ type: 'multipart/form-data' }) 使用

/**
 * 解析 multipart body
 * @param {Buffer} buf 原始请求体
 * @param {string} boundary Content-Type 中的 boundary
 * @returns {{ fields: Object<string,string>, files: Array<{fieldname, filename, mimetype, data: Buffer}> }}
 */
export function parseMultipart(buf, boundary) {
  const fields = {};
  const files = [];
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    const idx = buf.indexOf(delim, start);
    if (idx === -1) break;
    const next = buf.indexOf(Buffer.from('\r\n'), idx + delim.length);
    if (next === -1) break;
    // 判断结束标记 --boundary--
    const afterDelim = buf.slice(idx + delim.length, idx + delim.length + 2).toString();
    if (afterDelim === '--') break;
    const bodyStart = next + 2; // 跳过 \r\n
    const bodyEnd = buf.indexOf(Buffer.from('\r\n--' + boundary), bodyStart);
    if (bodyEnd === -1) break;
    parts.push(buf.slice(bodyStart, bodyEnd));
    start = bodyEnd + 2;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4);
    const nameMatch = /name="([^"]*)"/.exec(header);
    const filenameMatch = /filename="([^"]*)"/.exec(header);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(header);
    if (!nameMatch) continue;
    if (filenameMatch) {
      files.push({
        fieldname: nameMatch[1],
        filename: filenameMatch[1],
        mimetype: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: content,
      });
    } else {
      // 去尾部 \r\n
      let v = content.toString('utf8');
      if (v.endsWith('\r\n')) v = v.slice(0, -2);
      fields[nameMatch[1]] = v;
    }
  }
  return { fields, files };
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'application/pdf': 'pdf', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
};
export const ALLOWED_MIME = new Set(Object.keys(MIME_EXT));
export const extOf = (mime) => MIME_EXT[mime] || 'bin';
