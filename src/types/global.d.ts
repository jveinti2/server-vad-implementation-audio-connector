// Definición para compatibilidad con form-data
declare module "form-data" {
  class FormData {
    constructor();
    append(name: string, value: any, options?: any): void;
    getHeaders(): { [key: string]: string };
    getBuffer(): Buffer;
    getBoundary(): string;
    getLength(callback: (err: Error | null, length: number) => void): void;
    getLengthSync(): number;
    submit(
      params: string | URL,
      callback: (err: Error | null, res: any) => void
    ): void;
  }
  export = FormData;
}
