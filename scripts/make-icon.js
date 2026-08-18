'use strict';

/**
 * build/icon.png (1024x1024) 을 만든다.
 * electron-builder 가 여기서 각 플랫폼용 icns/ico 를 생성한다.
 * 외부 이미지 라이브러리를 쓰지 않도록 PNG 를 직접 인코딩한다.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

const COLORS = {
  bgTop: [0x2b, 0x2d, 0x30],
  bgBottom: [0x18, 0x19, 0x1b],
  diskTop: [0x6f, 0xa8, 0xff],
  diskBottom: [0x2f, 0x5d, 0xa8],
  edge: [0x8f, 0xbd, 0xff],
};

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** 부드러운 경계를 위해 픽셀당 4배 슈퍼샘플링한다. */
function coverage(test, x, y) {
  let hits = 0;
  for (const dx of [0.25, 0.75]) {
    for (const dy of [0.25, 0.75]) {
      if (test(x + dx, y + dy)) hits++;
    }
  }
  return hits / 4;
}

function blend(base, over, alpha) {
  return [
    Math.round(base[0] + (over[0] - base[0]) * alpha),
    Math.round(base[1] + (over[1] - base[1]) * alpha),
    Math.round(base[2] + (over[2] - base[2]) * alpha),
  ];
}

function build() {
  const s = SIZE / 1024;
  const cx = SIZE / 2;
  const rx = 300 * s;              // 원기둥 가로 반지름
  const ry = 92 * s;               // 원기둥 위/아래 타원의 세로 반지름
  const top = 300 * s;             // 위 타원 중심
  const bottom = 700 * s;          // 아래 타원 중심
  const radius = 200 * s;          // 배경 라운드 사각형 모서리

  const inEllipse = (x, y, ecy) => ((x - cx) ** 2) / (rx * rx) + ((y - ecy) ** 2) / (ry * ry) <= 1;
  const inBody = (x, y) => Math.abs(x - cx) <= rx && y >= top && y <= bottom;
  const inDisk = (x, y) => inBody(x, y) || inEllipse(x, y, top) || inEllipse(x, y, bottom);

  const inRounded = (x, y) => {
    const m = 40 * s;
    const l = m, r = SIZE - m, t = m, b = SIZE - m;
    if (x < l || x > r || y < t || y > b) return false;
    const qx = Math.min(Math.max(x, l + radius), r - radius);
    const qy = Math.min(Math.max(y, t + radius), b - radius);
    return (x - qx) ** 2 + (y - qy) ** 2 <= radius * radius;
  };

  // 원기둥 옆면에 디스크 경계선(아래로 휜 호)을 넣어 데이터베이스 느낌을 준다.
  const bandCenters = [top + (bottom - top) * 0.36, top + (bottom - top) * 0.68];
  const ellipseValue = (x, y, ecy) => ((x - cx) ** 2) / (rx * rx) + ((y - ecy) ** 2) / (ry * ry);
  const inBand = (x, y) => bandCenters.some((c) => {
    if (y < c) return false;
    const v = ellipseValue(x, y, c);
    return v <= 1 && v >= 0.955;
  });

  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let p = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0; // 필터 타입: None
    for (let x = 0; x < SIZE; x++) {
      const bgAlpha = coverage(inRounded, x, y);
      let rgb = lerp(COLORS.bgTop, COLORS.bgBottom, y / SIZE);

      const diskAlpha = coverage(inDisk, x, y);
      if (diskAlpha > 0) {
        const t = Math.min(1, Math.max(0, (y - (top - ry)) / (bottom + ry - (top - ry))));
        let disk = lerp(COLORS.diskTop, COLORS.diskBottom, t);
        // 위쪽 타원은 밝게 처리해 입체감을 준다.
        if (coverage((ax, ay) => inEllipse(ax, ay, top), x, y) > 0) {
          disk = blend(disk, COLORS.edge, 0.45);
        }
        if (coverage(inBand, x, y) > 0) disk = blend(disk, COLORS.bgBottom, 0.35);
        rgb = blend(rgb, disk, diskAlpha);
      }

      raw[p++] = rgb[0];
      raw[p++] = rgb[1];
      raw[p++] = rgb[2];
      raw[p++] = Math.round(255 * bgAlpha);
    }
  }

  return encodePng(SIZE, SIZE, raw);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function encodePng(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, build());
console.log(`wrote ${out}`);
