// Export utilities: STL and validation report
import { exportBinarySTL } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { ValidationResult, LatticeParams } from '../types/project';
import { massGrams } from '../geometry/metrics';
import type { LatticeMetrics } from '../geometry/metrics';
import { buildThreeMf } from './threemf';
import type { ThreeMfOptions } from './threemf';
import { buildObj } from './obj';
import type { ObjOptions } from './obj';
import { buildIndexedMesh } from '../geometry/mesh-indexing';
import type { IndexedMesh } from '../geometry/mesh-indexing';
import { decimateMesh } from '../geometry/decimate';

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface MeshExportOptions {
  /** Fraction of triangles to keep. 1 exports the mesh unchanged. */
  simplifyRatio?: number;
  /** Largest deviation a single collapse may introduce, mm. */
  maxError?: number;
}

/**
 * Index the mesh once, and simplify it if asked.
 *
 * Every format wants indexed geometry, and simplification has to happen before
 * indexing is consumed, so both steps live here rather than in each writer.
 */
function prepareMesh(result: MarchingCubesResult, options: MeshExportOptions = {}): IndexedMesh {
  const indexed = buildIndexedMesh(result);
  const ratio = options.simplifyRatio ?? 1;
  if (ratio >= 1) return indexed;
  return decimateMesh(indexed, { targetRatio: ratio, maxError: options.maxError }).mesh;
}

/** Expand back to soup, recomputing face normals from the final winding. */
function toSoup(mesh: IndexedMesh): MarchingCubesResult {
  const positions = new Float32Array(mesh.triangleCount * 9);
  const normals = new Float32Array(mesh.triangleCount * 3);

  for (let i = 0; i < mesh.triangleCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[i * 3 + k];
      positions[i * 9 + k * 3] = mesh.positions[v * 3];
      positions[i * 9 + k * 3 + 1] = mesh.positions[v * 3 + 1];
      positions[i * 9 + k * 3 + 2] = mesh.positions[v * 3 + 2];
    }
    const o = i * 9;
    const e1x = positions[o + 3] - positions[o];
    const e1y = positions[o + 4] - positions[o + 1];
    const e1z = positions[o + 5] - positions[o + 2];
    const e2x = positions[o + 6] - positions[o];
    const e2y = positions[o + 7] - positions[o + 1];
    const e2z = positions[o + 8] - positions[o + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-12) {
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
    }
  }

  return { positions, normals, triCount: mesh.triangleCount };
}

export async function download3MF(
  result: MarchingCubesResult,
  options: ThreeMfOptions,
  mesh: MeshExportOptions = {},
  filename: string = 'lattice-design.3mf'
) {
  const bytes = await buildThreeMf(prepareMesh(result, mesh), options);
  saveBlob(new Blob([bytes as BlobPart], { type: 'model/3mf' }), filename);
}

export function downloadOBJ(
  result: MarchingCubesResult,
  options: ObjOptions,
  mesh: MeshExportOptions = {},
  filename: string = 'lattice-design.obj'
) {
  const bytes = buildObj(prepareMesh(result, mesh), options);
  saveBlob(new Blob([bytes as BlobPart], { type: 'model/obj' }), filename);
}

export function downloadSTL(
  result: MarchingCubesResult,
  filename: string = 'lattice-design.stl',
  mesh: MeshExportOptions = {}
) {
  const source = (mesh.simplifyRatio ?? 1) >= 1 ? result : toSoup(prepareMesh(result, mesh));
  const buffer = exportBinarySTL(source.positions, source.normals, source.triCount);
  saveBlob(new Blob([buffer], { type: 'application/octet-stream' }), filename);
}

export function downloadValidationReport(
  validation: ValidationResult,
  params: LatticeParams,
  meshFileName: string,
  metrics: LatticeMetrics | null = null,
  material: { name: string; density: number } | null = null,
  filename: string = 'validation-report.json'
) {
  const report = {
    timestamp: new Date().toISOString(),
    meshFile: meshFileName,
    parameters: params,
    metrics: metrics && {
      envelopeVolumeMm3: metrics.envelopeVolume,
      latticeVolumeMm3: metrics.latticeVolume,
      relativeDensity: metrics.relativeDensity,
      surfaceAreaMm2: metrics.surfaceArea,
      massGrams: material ? massGrams(metrics.latticeVolume, material.density) : null,
      solidMassGrams: material ? massGrams(metrics.envelopeVolume, material.density) : null,
      material: material?.name ?? null,
      materialDensityGramsPerCm3: material?.density ?? null,
      basis: {
        volume: `occupancy sampling, ${metrics.volumeSamplesPerAxis}^3 field samples`,
        envelopeVolume: 'exact (divergence theorem on the source solid)',
        surfaceArea: 'extracted mesh at the current export resolution',
      },
    },
    validation: {
      overallPassed: validation.passed,
      outerDeviation: validation.outerDeviation,
      minThickness: validation.minThickness,
      manifold: validation.manifold,
      disconnectedPieces: validation.disconnected,
      warnings: validation.warnings,
    },
  };
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export project data as JSON */
export function downloadProjectJSON(
  params: LatticeParams,
  meshFileName: string,
  keepOutTris: Set<number>,
  keepInTris: Set<number>,
  validation: ValidationResult | null,
) {
  const project = {
    meshAssetName: meshFileName,
    selectionMask: {
      keepOut: Array.from(keepOutTris),
      keepIn: Array.from(keepInTris),
    },
    parameters: params,
    validation: validation,
  };
  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lattice-project.json';
  a.click();
  URL.revokeObjectURL(url);
}
