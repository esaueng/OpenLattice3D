import type { LatticeParams } from '../../types/project';

type SkinParams = Pick<LatticeParams, 'noShell' | 'surfaceOnly' | 'shellThickness'>;

/**
 * Whether a result was generated with a closed outer skin, which hides the
 * lattice in the Solid view. No-shell and surface-only runs leave the lattice
 * exposed; a shell of zero thickness is no skin.
 */
export function resultHasClosedSkin(params: SkinParams | null | undefined): boolean {
  if (!params) return false;
  return !params.noShell && !params.surfaceOnly && params.shellThickness > 0;
}
