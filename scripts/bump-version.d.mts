export declare const BUMPS: readonly string[];
export declare const FILES: Record<string, RegExp>;
export declare function nextVersion(version: string, bump: string): string;
export declare function withVersion(text: string, pattern: RegExp, version: string): string;
