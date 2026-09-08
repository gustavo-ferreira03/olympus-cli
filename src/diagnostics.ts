import { sanitizeDiagnostic } from "./errors.ts";
import { StringDecoder } from "node:string_decoder";

export function installDiagnosticOutput(): () => void {
  const original = process.stderr.write;
  const write = original.bind(process.stderr);
  const decoder = new StringDecoder("utf8");
  const filtered = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text =
      typeof chunk === "string"
        ? decoder.end() + chunk
        : decoder.write(Buffer.from(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    return write(sanitizeDiagnostic(text.replace(/\r/g, "\n")), done);
  }) as typeof process.stderr.write;
  process.stderr.write = filtered;
  return () => {
    if (process.stderr.write === filtered) {
      const trailing = decoder.end();
      if (trailing) write(sanitizeDiagnostic(trailing));
      process.stderr.write = original;
    }
  };
}
