import {readFile, writeFile} from 'node:fs/promises';
import {deflateSync, inflateSync} from 'node:zlib';

const source = await readFile('app/icons/icon-128.png');
const width = source.readUInt32BE(16), height = source.readUInt32BE(20);
let offset = 8, compressed = Buffer.alloc(0);
while (offset < source.length) {
  const length = source.readUInt32BE(offset), type = source.toString('ascii', offset + 4, offset + 8);
  if (type === 'IDAT') compressed = Buffer.concat([compressed, source.subarray(offset + 8, offset + 8 + length)]);
  offset += length + 12;
}
const packed = inflateSync(compressed), pixels = Buffer.alloc(width * height * 4);
let previous = Buffer.alloc(width * 4), at = 0;
for (let y = 0; y < height; y++) {
  const filter = packed[at++], row = Buffer.from(packed.subarray(at, at += width * 4));
  for (let x = 0; x < row.length; x++) {
    const left = x >= 4 ? row[x - 4] : 0, up = previous[x], upLeft = x >= 4 ? previous[x - 4] : 0;
    if (filter === 1) row[x] = (row[x] + left) & 255;
    if (filter === 2) row[x] = (row[x] + up) & 255;
    if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
    if (filter === 4) { const p = left + up - upLeft, pa = Math.abs(p-left), pb = Math.abs(p-up), pc = Math.abs(p-upLeft); row[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255; }
  }
  row.copy(pixels, y * width * 4); previous = row;
}
let minX=width, minY=height, maxX=0, maxY=0;
for (let y=0;y<height;y++) for (let x=0;x<width;x++) if (pixels[(y*width+x)*4+3] > 8) { minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); }
const crcTable = Uint32Array.from({length:256}, (_,n) => { let c=n; for(let k=0;k<8;k++) c=c&1 ? 0xedb88320^(c>>>1) : c>>>1; return c>>>0; });
const crc = data => { let c=0xffffffff; for(const b of data)c=crcTable[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0; };
const chunk = (type,data) => { const head=Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type,4); const tail=Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type),data]))); return Buffer.concat([head,data,tail]); };
for (const size of [16,32,48,128]) {
  const pad = Math.max(1, Math.round(size * .06)), inner = size - pad * 2, out = Buffer.alloc((size * 4 + 1) * size);
  for (let y=0;y<size;y++) { out[y*(size*4+1)] = 0; for(let x=0;x<size;x++) { const dx=(x-pad+.5)/inner, dy=(y-pad+.5)/inner; const sx=Math.round(minX + dx*(maxX-minX)), sy=Math.round(minY + dy*(maxY-minY)); if(dx>=0&&dx<=1&&dy>=0&&dy<=1) pixels.copy(out, y*(size*4+1)+1+x*4, (sy*width+sx)*4, (sy*width+sx)*4+4); } }
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size,4); ihdr[8]=8; ihdr[9]=6;
  await writeFile(`app/icons/icon-${size}.png`, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(out)),chunk('IEND',Buffer.alloc(0))]));
}
