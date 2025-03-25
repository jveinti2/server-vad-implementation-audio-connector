declare module 'pcm-util' {
  export function pcm16ToMulaw(buffer: Buffer): Buffer;
  export function mulawToPcm16(buffer: Buffer): Buffer;
} 