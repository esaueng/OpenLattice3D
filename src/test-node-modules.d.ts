declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options: { recursive: boolean }): void;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}

declare module 'node:os' {
  export function platform(): string;
  export function arch(): string;
  export function cpus(): { model: string }[];
}

declare const process: {
  env: Record<string, string | undefined>;
  version: string;
};
