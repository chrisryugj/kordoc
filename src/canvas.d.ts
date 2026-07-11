declare module "canvas" {
  export function createCanvas(width: number, height: number): {
    getContext(type: string): unknown
    toBuffer(type: string): Buffer
  }
}
