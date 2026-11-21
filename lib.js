// Ferramentas sem dependências: ZIP (sem compressão) e PDF a partir de JPEGs.
// Fotos e PDFs já vêm comprimidos, por isso o ZIP só guarda os ficheiros.

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ path: 'pasta/ficheiro.jpg', bytes: Uint8Array, date?: Date }]
export function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.bytes);
    const { time, date } = dosDateTime(e.date || new Date());
    const size = e.bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nomes em UTF-8
    local.setUint16(8, 0, true); // sem compressão
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, e.bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// Lê um ZIP criado por makeZip (sem compressão). Devolve [{ path, bytes }].
export function readZip(buffer) {
  const v = new DataView(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('não é um ZIP');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  // Um ZIP forjado pode apontar muitas entradas para os mesmos bytes ou para fora do ficheiro:
  // cada entrada tem de caber no ficheiro e as entradas devolvem vistas, nunca cópias.
  const invalid = () => new Error('ZIP inválido');
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw invalid();
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const path = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
    if (method !== 0) throw new Error('ZIP comprimido não suportado');
    if (v.getUint32(local, true) !== 0x04034b50) throw invalid();
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (dataStart + size > eocd) throw invalid();
    out.push({ path, bytes: new Uint8Array(buffer, dataStart, size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// pages: [{ bytes: Uint8Array (JPEG), width, height }] -> Blob PDF, uma página por imagem.
export function makePdf(pages) {
  const A4_WIDTH = 595;
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (data) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    pos += b.length;
  };
  const obj = (id, body) => {
    offsets[id] = pos;
    push(`${id} 0 obj\n`);
    for (const b of [].concat(body)) push(b);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const pageId = 3 + i * 3;
    const imgId = pageId + 1;
    const contentId = pageId + 2;
    const w = A4_WIDTH;
    const h = Math.round((p.height / p.width) * A4_WIDTH);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    obj(imgId, [
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`,
      p.bytes,
      '\nendstream',
    ]);
    obj(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  const count = 3 + pages.length * 3;
  const xref = pos;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
