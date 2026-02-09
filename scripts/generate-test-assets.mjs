#!/usr/bin/env node
// Generate test STL assets: sphere and cube

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'assets');
mkdirSync(outDir, { recursive: true });

function generateSphere(radius, segments) {
  const tris = [];
  for (let lat = 0; lat < segments; lat++) {
    for (let lon = 0; lon < segments * 2; lon++) {
      const theta0 = (Math.PI * lat) / segments;
      const theta1 = (Math.PI * (lat + 1)) / segments;
      const phi0 = (2 * Math.PI * lon) / (segments * 2);
      const phi1 = (2 * Math.PI * (lon + 1)) / (segments * 2);

      const p = (t, p) => [
        radius * Math.sin(t) * Math.cos(p),
        radius * Math.sin(t) * Math.sin(p),
        radius * Math.cos(t),
      ];

      const p00 = p(theta0, phi0);
      const p01 = p(theta0, phi1);
      const p10 = p(theta1, phi0);
      const p11 = p(theta1, phi1);

      if (lat > 0) tris.push([p00, p01, p10]);
      if (lat < segments - 1) tris.push([p01, p11, p10]);
    }
  }
  return tris;
}

function generateCube(size) {
  const h = size / 2;
  const faces = [
    [[-h,-h,h],[h,-h,h],[h,h,h]], [[-h,-h,h],[h,h,h],[-h,h,h]],
    [[h,-h,-h],[-h,-h,-h],[-h,h,-h]], [[h,-h,-h],[-h,h,-h],[h,h,-h]],
    [[-h,h,h],[h,h,h],[h,h,-h]], [[-h,h,h],[h,h,-h],[-h,h,-h]],
    [[-h,-h,-h],[h,-h,-h],[h,-h,h]], [[-h,-h,-h],[h,-h,h],[-h,-h,h]],
    [[h,-h,h],[h,-h,-h],[h,h,-h]], [[h,-h,h],[h,h,-h],[h,h,h]],
    [[-h,-h,-h],[-h,-h,h],[-h,h,h]], [[-h,-h,-h],[-h,h,h],[-h,h,-h]],
  ];
  return faces;
}

function cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

function sub(a, b) {
  return [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
}

function normalize(v) {
  const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
  return l > 0 ? [v[0]/l, v[1]/l, v[2]/l] : [0,0,0];
}

function writeBinarySTL(filepath, tris) {
  const triCount = tris.length;
  const buf = Buffer.alloc(84 + triCount * 50);
  buf.write('Generated Test Asset', 0);
  buf.writeUInt32LE(triCount, 80);

  for (let i = 0; i < triCount; i++) {
    const [v0, v1, v2] = tris[i];
    const n = normalize(cross(sub(v1, v0), sub(v2, v0)));
    const off = 84 + i * 50;
    buf.writeFloatLE(n[0], off);
    buf.writeFloatLE(n[1], off + 4);
    buf.writeFloatLE(n[2], off + 8);
    for (let v = 0; v < 3; v++) {
      const vert = tris[i][v];
      buf.writeFloatLE(vert[0], off + 12 + v * 12);
      buf.writeFloatLE(vert[1], off + 12 + v * 12 + 4);
      buf.writeFloatLE(vert[2], off + 12 + v * 12 + 8);
    }
    buf.writeUInt16LE(0, off + 48);
  }

  writeFileSync(filepath, buf);
  console.log(`Wrote ${filepath} (${triCount} triangles, ${buf.length} bytes)`);
}

// Generate sphere R=25mm
writeBinarySTL(join(outDir, 'sphere-25mm.stl'), generateSphere(25, 32));

// Generate cube 30mm
writeBinarySTL(join(outDir, 'cube-30mm.stl'), generateCube(30));

// Generate small sphere R=10mm  
writeBinarySTL(join(outDir, 'sphere-10mm.stl'), generateSphere(10, 24));

console.log('Test assets generated in public/assets/');
