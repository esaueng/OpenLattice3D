declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
}
